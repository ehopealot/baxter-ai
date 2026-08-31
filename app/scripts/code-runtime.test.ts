import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const coreRoot = fileURLToPath(new URL("../../", import.meta.url));
const compose = readFileSync(fileURLToPath(new URL("../../compose.yaml", import.meta.url)), "utf8");
const makefile = readFileSync(fileURLToPath(new URL("../../Makefile", import.meta.url)), "utf8");
const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");
const dockerignore = readFileSync(fileURLToPath(new URL("../.dockerignore", import.meta.url)), "utf8");
const gitignore = readFileSync(fileURLToPath(new URL("../../.gitignore", import.meta.url)), "utf8");
const browserDocs = readFileSync(fileURLToPath(new URL("../docs/architecture/browsers.md", import.meta.url)), "utf8");
const envExample = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
const signerPath = fileURLToPath(new URL("./code-executor-signer.ts", import.meta.url));

function directCredentialEnvEntries(service: string): RegExpMatchArray[] {
  const serviceStart = new RegExp(`^  ${service}:`, "m").exec(compose)?.index;
  const nextService = serviceStart === undefined ? undefined : /^  [a-z][\w-]+:/gm.exec(compose.slice(serviceStart + 1))?.index;
  const block = serviceStart === undefined ? "" : compose.slice(serviceStart, nextService === undefined ? undefined : serviceStart + 1 + nextService);
  return [...block.matchAll(/- path: \$\{CODE_EXECUTOR_ENV:-app\/code-executor\.env\}\n\s+required: false/g)];
}

test("core has only direct remote code execution in app containers", () => {
  assert.doesNotMatch(compose, /^  codapi:/m);
  assert.doesNotMatch(compose, /code-executor-signer|code-executor-socket|remote-code|setpriv|cap_add:/);
  assert.equal(directCredentialEnvEntries("discord").length, 1);
  assert.equal(directCredentialEnvEntries("light").length, 1);
  assert.doesNotMatch(compose, /CODAPI_|depends_on: \[codapi\]|docker\.sock/);
  assert.match(makefile, /check-code-executor/);
  for (const target of ["run", "mail", "discord", "tui", "tui-run", "heartbeat", "home", "app-shell"]) {
    assert.match(makefile, new RegExp(`^${target}:.*\\bcheck-code-executor\\b`, "m"));
  }
  assert.match(makefile, /CODE_EXECUTOR_ENV/);
  assert.match(makefile, /up -d --remove-orphans/);
  assert.match(makefile, /down --remove-orphans/);
  assert.match(makefile, /docker rm -f[\s\S]*\$\(PROJECT\)-code-executor-signer/);
  assert.match(makefile, /docker volume rm "\$\(PROJECT\)-code-executor-socket"/);
  assert.doesNotMatch(makefile, /CODE_EXECUTOR_SIGNER_ENV|CODE_EXECUTOR_PROFILE|remote-code/);
  assert.match(makefile, /APP_WORKTREE_ID := \$\(shell .*sha256sum/);
  assert.match(makefile, /-dirty-\$\(APP_WORKTREE_ID\)/);
  assert.doesNotMatch(makefile, /build-codapi|^codapi:/m);
  assert.doesNotMatch(dockerfile, /\butil-linux\b/);
  assert.doesNotMatch(envExample, /^# CODE_EXECUTOR_SOCKET=/m);
  assert.doesNotMatch(envExample, /^# CODE_EXECUTOR_KEYS_PATH=/m);
  assert.match(envExample, /separate[\s#]+final code-executor\.env file/);
  assert.match(dockerignore, /^\*\*\/code-executor\.env$/m);
  assert.match(gitignore, /^\*\*\/code-executor\.env$/m);
  assert.match(dockerfile, /ARG INVISIBLE_PLAYWRIGHT_REV=cbbdda07be32c620aa3b0d2adbd2c18e8ff2213d/);
  assert.match(dockerfile, /invisible_playwright\.git@\$\{INVISIBLE_PLAYWRIGHT_REV\}/);
  assert.match(browserDocs, /v0\.8\.3.*cbbdda07be32c620aa3b0d2adbd2c18e8ff2213d/s);
  assert.doesNotMatch(browserDocs, /pyproject\.toml` pins `playwright>=1\.55,<1\.56`/);
  assert.match(dockerfile, /ARG PLAYWRIGHT_SYSTEM_TOOL_VERSION=1\.61\.0/);
  assert.match(dockerfile, /pip install --no-cache-dir "playwright==\$\{PLAYWRIGHT_SYSTEM_TOOL_VERSION\}"[\s\S]*?python -m playwright install-deps firefox[\s\S]*?pip uninstall -y playwright/);
  assert.equal(existsSync(signerPath), false);
});

test("an explicit empty executor mode fails the Make preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-executor-mode-"));
  try {
    const tenantEnv = join(dir, "app.env");
    writeFileSync(tenantEnv, "BAXTER_CODE_EXECUTOR=\nCODE_EXECUTOR_SOCKET=\nCODE_EXECUTOR_KEYS_PATH=\n");
    const env = { ...process.env };
    delete env.BAXTER_CODE_EXECUTOR;
    const result = spawnSync("make", ["-C", coreRoot, "check-code-executor", `TENANT_ENV=${tenantEnv}`], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /BAXTER_CODE_EXECUTOR must be remote/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("only the final executor env file may carry direct credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-executor-source-"));
  try {
    const baseEnv = join(dir, "base.env");
    const baseSecretsEnv = join(dir, "base-secrets.env");
    const tenantEnv = join(dir, "app.env");
    const credentialEnv = join(dir, "code-executor.env");
    const safeTenant = "BAXTER_CODE_EXECUTOR=remote\nCODE_EXECUTOR_URL=\nCODE_EXECUTOR_ACCESS_KEY_ID=\nCODE_EXECUTOR_SECRET_ACCESS_KEY=\n";
    writeFileSync(baseEnv, "");
    writeFileSync(baseSecretsEnv, "");
    writeFileSync(tenantEnv, safeTenant);
    writeFileSync(credentialEnv, "CODE_EXECUTOR_URL=https://executor.example.invalid/\nCODE_EXECUTOR_ACCESS_KEY_ID=bce1_aG9wZQ_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nCODE_EXECUTOR_SECRET_ACCESS_KEY=executor-secret-not-to-log-1234567890\n");
    const env = { ...process.env };
    delete env.BAXTER_CODE_EXECUTOR;
    const args = ["-C", coreRoot, "check-code-executor", `BASE_ENV=${baseEnv}`, `BASE_SECRETS_ENV=${baseSecretsEnv}`, `TENANT_ENV=${tenantEnv}`, `CODE_EXECUTOR_ENV=${credentialEnv}`];

    const blankResult = spawnSync("make", args, { encoding: "utf8", env });
    assert.equal(blankResult.status, 0, blankResult.stderr);

    for (const source of [baseEnv, baseSecretsEnv, tenantEnv]) {
      for (const prefix of ["", "  ", "\t"]) {
        writeFileSync(source, `${source === tenantEnv ? "BAXTER_CODE_EXECUTOR=remote\n" : ""}${prefix}CODE_EXECUTOR_SECRET_ACCESS_KEY=executor-secret-not-to-log-1234567890\n`);
        const result = spawnSync("make", args, { encoding: "utf8", env });
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stderr, /direct executor credentials must be supplied only by CODE_EXECUTOR_ENV/);
        assert.doesNotMatch(result.stderr, /executor-secret-not-to-log/);
      }
      writeFileSync(source, source === tenantEnv ? safeTenant : "");
    }

    for (const source of [baseEnv, baseSecretsEnv, tenantEnv]) {
      writeFileSync(source, `${source === tenantEnv ? "BAXTER_CODE_EXECUTOR=remote\n" : ""}\tCODE_EXECUTOR_SOCKET=retired-socket-not-to-log\n`);
      const result = spawnSync("make", args, { encoding: "utf8", env });
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /retired executor transport settings must be removed/);
      assert.doesNotMatch(result.stderr, /retired-socket-not-to-log/);
      writeFileSync(source, source === tenantEnv ? safeTenant : "");
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
