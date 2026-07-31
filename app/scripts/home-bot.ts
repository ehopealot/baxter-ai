#!/usr/bin/env node
// The family-home surface driver (spec §2). A long-running process, gated by the `home`
// token in BAXTER_SURFACES (compose profile) -- deliberately NOT in-process with the agent
// and NOT tied to Discord, so the web page works on a tenant that runs no other surface.
//
// It owns the tick loop; ALL the logic lives in home-mirror.ts behind the HomeOps seam.
// The DO sets the cadence (pollAfterSeconds); we obey it, clamped to [2s,60s]. A tap NEVER
// wakes an LLM run -- there are no model calls here or in home-mirror.ts.
import { loadHomeKeys, signedHomeOps, runSyncTick, freshMemo, STOP_SYNCING } from "./home-mirror.ts";
import type { TickDeps } from "./home-mirror.ts";
import { CHECKLISTS_PATH, HOME_STATE_PATH } from "./paths.ts";
import { log, logErr } from "./runtime.ts";

async function main(): Promise<void> {
  let keys;
  try {
    keys = loadHomeKeys();
  } catch (err) {
    // Absent credential -> log once and idle (do NOT crash the container). A malformed file
    // is treated the same way: idle loudly rather than crash-loop the surface.
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") log("home: no home-keys.json -- family-home surface idle (provision with `baxctl home <id>`)");
    else logErr(`home: home-keys.json unreadable (${e.message}) -- family-home surface idle until it's fixed`);
    return;
  }

  const deps: TickDeps = {
    ops: signedHomeOps(keys),
    checklistsPath: CHECKLISTS_PATH,
    statePath: HOME_STATE_PATH,
    // v1 ships lists-only: projects are stubbed (spec §4). The 413-latch logic in
    // home-mirror.ts is real regardless. Real project rendering needs a markdown->HTML
    // sanitizer allow-list (the sharpest security edge; see the spec) before it's enabled.
    buildProjects: () => [],
    env: process.env,
    now: () => Date.now(),
    log,
    logErr,
    // No pager in core v1: an "alert" is a loud, greppable log line the operator sees via
    // `ssh <box> docker logs`. Distinct prefix so it stands out from routine sync chatter.
    alert: (m) => logErr(`home ALERT: ${m}`),
  };

  const memo = freshMemo();
  log(`home: family-home surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);

  // Reentrancy is structural (each tick schedules the next only after it resolves), so no
  // guard flag is needed. A thrown tick backs off to the idle rung rather than dying.
  const tick = async (): Promise<void> => {
    let delayMs: number;
    try {
      delayMs = await runSyncTick(deps, memo);
    } catch (err) {
      logErr(`home: unexpected tick error: ${(err as Error).message}`);
      delayMs = 60_000;
    }
    if (delayMs === STOP_SYNCING) { logErr("home: sync loop stopped (fatal config error above -- fix and restart the surface)"); return; }
    setTimeout(() => { void tick(); }, delayMs);
  };
  void tick();
}

main().catch((err) => { logErr(`home: fatal: ${(err as Error).message}`); process.exit(1); });
