import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerLine } from "./runner-events.ts";

const RUNNER = fileURLToPath(new URL("./openrouter-runner.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("./fixtures/openrouter-agent-loader.mjs", import.meta.url));

function cliDirectory(names: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "openrouter-runner-cli-"));
  for (const name of names) {
    const path = join(directory, name);
    writeFileSync(path, "#!/bin/sh\necho '{\"ok\":true}'\n");
    chmodSync(path, 0o755);
  }
  return directory;
}

async function runRunner(scenario: string, allowed: string, pathDir: string): Promise<{ events: RunnerLine[]; code: number | null }> {
  const child = spawn(process.execPath, ["--experimental-loader", LOADER, RUNNER, "--allowed", allowed], {
    env: {
      ...process.env,
      BAXTER_HARNESS: "openrouter",
      BAXTER_WORKER_MODE: "",
      BAXTER_WORKER_CONTROL_DIR: "",
      BAXTER_OPENROUTER_RUNNER_TEST_SCENARIO: scenario,
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "test-model",
      OPENROUTER_FALLBACK_MODEL: "",
      OPENROUTER_STREAM_RETRY_MAX: "0",
      BAXTER_EXPECT_REPLY: scenario === "revoked-during-nudge" ? "1" : "",
      PATH: `${pathDir}:${process.env.PATH}`,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end("do the task");
  let output = "";
  for await (const chunk of child.stdout) output += chunk;
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  const events = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as RunnerLine);
  return { events, code };
}

function assertRevocationFailed(events: RunnerLine[], code: number | null): void {
  assert.equal(code, 1, "lease revocation must leave a nonzero runner exit");
  assert.equal(events.some(event => event.t === "result" && event.subtype === "success"), false, "lease revocation must not publish terminal success");
  assert.equal(events.at(-1)?.subtype, "error");
  assert.match(events.at(-1)?.text ?? "", /worker lease revoked/);
}

test("openrouter-runner: wrapped lease revocation after delivery bypasses delivered success", async () => {
  const directory = cliDirectory(["discord-cli"]);
  try {
    const { events, code } = await runRunner("revoked-after-delivery", "Bash(discord-cli *)", directory);
    assertRevocationFailed(events, code);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("openrouter-runner: wrapped lease revocation during a nudge is not best-effort success", async () => {
  const directory = cliDirectory([]);
  try {
    const { events, code } = await runRunner("revoked-during-nudge", "", directory);
    assertRevocationFailed(events, code);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("openrouter-runner: final response stream revocation cannot publish no-reply success", async () => {
  const directory = cliDirectory(["sms-cli"]);
  try {
    const { events, code } = await runRunner("revoked-final-wrap", "Bash(sms-cli *)", directory);
    assertRevocationFailed(events, code);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
