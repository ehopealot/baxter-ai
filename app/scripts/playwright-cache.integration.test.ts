import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_VERSION = "0.1.18";
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(HERE, "..", "Dockerfile");
const CORE_MAKEFILE = join(HERE, "..", "..", "Makefile");
const RUN_REAL_CLI = process.env.BAXTER_PLAYWRIGHT_CACHE_INTEGRATION === "1";

function cli(cwd: string, ...args: string[]) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=@playwright/cli@${CLI_VERSION}`, "playwright-cli", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_UPDATE_NOTIFIER: "1" },
      timeout: 120_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `playwright-cli ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result;
}

test("Docker image pins the Playwright CLI version exactly", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  assert.match(dockerfile, /^ARG PLAYWRIGHT_CLI_VERSION=0\.1\.18$/m);
  assert.doesNotMatch(dockerfile, /^ARG PLAYWRIGHT_CLI_VERSION=(latest|[~^])/m);
  assert.match(readFileSync(CORE_MAKEFILE, "utf8"), /^PLAYWRIGHT_CLI_VERSION := 0\.1\.18$/m);
});

test("Core BusyBox backup excludes complete cache trees and preserves durable browser state", (t) => {
  const makefile = readFileSync(CORE_MAKEFILE, "utf8");
  const recipe = makefile.match(/backup:\n([\s\S]*?)\n\t@ls -lh/)?.[1] ?? "";
  const excludes = [...recipe.matchAll(/--exclude='([^']+)'/g)].map((match) => `--exclude=${match[1]}`);
  assert.deepEqual(excludes, [
    "--exclude=*/.playwright-cli",
    "--exclude=*/.playwright-cli/*",
    "--exclude=*/.playwright/*Singleton*",
  ]);

  const busyboxHelp = spawnSync("busybox", ["tar", "--help"], { encoding: "utf8" });
  if (busyboxHelp.error || !`${busyboxHelp.stdout}${busyboxHelp.stderr}`.includes("--exclude")) {
    t.skip("host BusyBox tar lacks --exclude (the production Alpine tar provides it)");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "core-cache-archive-"));
  const archive = join(root, "backup.tar.gz");
  const add = (path: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, path);
  };
  add(".mail-agent/memory-workspace/.playwright-cli/snapshots/old.yml");
  add(".mail-agent/memory-workspace/.playwright/chromium-profile/Default/Cookies");
  add(".mail-agent/invisible-state.json");
  add(".mail-agent/memory-workspace/scripts/login.ts");
  add(".mail-agent/memory-workspace/named-state-save.json");
  add(".mail-agent/memory-workspace/.playwright-cli-durable/keep.txt");

  try {
    const created = spawnSync("busybox", ["tar", "czf", archive, "-C", root, ...excludes, ".mail-agent"], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const listed = spawnSync("busybox", ["tar", "tzf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    const members = listed.stdout.split("\n").filter(Boolean);
    assert.equal(members.some((member) => member.split("/").includes(".playwright-cli")), false);
    for (const suffix of [
      ".playwright/chromium-profile/Default/Cookies",
      "invisible-state.json",
      "scripts/login.ts",
      "named-state-save.json",
      ".playwright-cli-durable/keep.txt",
    ]) assert.ok(members.some((member) => member.endsWith(suffix)), `archive lost ${suffix}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinned Playwright CLI evicts old output but preserves files from the current command", { skip: !RUN_REAL_CLI }, () => {
  const root = mkdtempSync(join(tmpdir(), "playwright-cache-"));
  const output = join(root, ".playwright-cli");
  const configDir = join(root, ".playwright");
  mkdirSync(output, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "cli.config.json"), JSON.stringify({
    browser: { browserName: "chromium", launchOptions: { channel: "chromium" } },
    outputDir: output,
    outputMaxSize: 1024,
  }));

  const version = cli(root, "--version").stdout.trim();
  assert.equal(version, CLI_VERSION);

  try {
    cli(root, "open", "about:blank");
    const old = join(output, "old-output.bin");
    writeFileSync(old, Buffer.alloc(2048, 0x61));
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(old, oldTime, oldTime);

    cli(root, "screenshot");

    assert.equal(existsSync(old), false, "old output should be evicted after the command");
    const currentFiles = filesBelow(output);
    assert.ok(currentFiles.length > 0, "the screenshot command should write current output");
    assert.ok(currentFiles.some((path) => /\.png$/i.test(path)), `missing current screenshot in ${currentFiles.join(", ")}`);
  } finally {
    spawnSync("npx", ["--yes", `--package=@playwright/cli@${CLI_VERSION}`, "playwright-cli", "close"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_UPDATE_NOTIFIER: "1" },
      timeout: 30_000,
    });
    rmSync(root, { recursive: true, force: true });
  }
});
