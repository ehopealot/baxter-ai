import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const source = (name: string): string => readFileSync(join(scriptsDir, name), "utf8");

function productionTs(dir = scriptsDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionTs(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testkit.ts")) out.push(path);
  }
  return out;
}

test("finite light provider callsite inventory routes delivery, SDK, model, moderation, and calendar defaults through providerFetch", () => {
  const inventory: Array<[string, RegExp]> = [
    ["calendar-cli.ts", /providerFetch/],
    ["chat-title.ts", /deps\.fetchImpl \?\? providerFetch/],
    ["collection-renderer.ts", /providerFetch/],
    ["discord-cli.ts", /await providerFetch\(/],
    ["home-bot.ts", /fetch: providerFetch/],
    ["log-shipper.ts", /fetchFn = providerFetch/],
    ["mail-cli.ts", /createProviderResend/],
    ["moderation.ts", /await providerFetch\(/],
    ["morning-check-in.ts", /deps\.fetchFn \?\? providerFetch/],
    ["provider-resend.ts", /fetchImpl: FetchLike = providerFetch/],
    ["sms-cli.ts", /deps\.fetchImpl \?\? providerFetch/],
    ["harnesses\/custom-runner.ts", /await providerFetch\(/],
    ["harnesses\/local-runner.ts", /await providerFetch\(/],
    ["harnesses\/openrouter-runner.ts", /fetcher: providerFetch/],
  ];
  for (const [file, evidence] of inventory) assert.match(source(file), evidence, file);

  const directResend = productionTs().filter(path => /new Resend\s*\(/.test(readFileSync(path, "utf8"))).map(path => relative(scriptsDir, path));
  assert.deepEqual(directResend, ["provider-resend.ts"], "all Resend SDK construction is centralized behind the provider transport override");

  const bareFetch = productionTs().filter(path => /\bawait\s+fetch\s*\(/.test(readFileSync(path, "utf8"))).map(path => relative(scriptsDir, path)).sort();
  assert.deepEqual(bareFetch, ["code-cli.ts", "web-cli.ts"], "only local Codapi and credentialless arbitrary web access directly await global fetch");
});

test("finite raw watcher inventory acquires lifecycle ownership before every debounce timer", () => {
  const inventory: Array<[string, string]> = [
    ["home-bot.ts", "watchChecklistStore"],
    ["home-bot.ts", "watchSchedule"],
    ["recipes-mirror.ts", "watchRecipes"],
    ["calendar-mirror.ts", "watchCalendar"],
    ["chat-bot.ts", "watchChats"],
  ];
  for (const [file, exportedName] of inventory) {
    const text = source(file);
    const start = text.indexOf(`export function ${exportedName}`);
    assert.ok(start >= 0, `${file}:${exportedName} remains discoverable`);
    const nextExport = text.indexOf("\nexport function ", start + 1);
    const body = text.slice(start, nextExport < 0 ? undefined : nextExport);
    assert.match(body, /pendingRelease = admit\?\.\(\)/, `${file}:${exportedName} admits in the raw callback`);
    assert.match(body, /if \(!admit && timer !== null\)/, `${file}:${exportedName} drains mature lifecycle debounce on close`);
  }
});
