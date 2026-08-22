import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAKEFILE = join(CORE, "Makefile");
const SET_ENV = join(CORE, "app", "scripts", "set-env-var.sh");
const OLLAMA = join(CORE, "ollama.sh");

test("every canonical writable runtime target names an admission prerequisite", () => {
  const makefile = readFileSync(MAKEFILE, "utf8");
  for (const target of ["run", "voice", "home", "heartbeat"]) {
    assert.match(makefile, new RegExp(`^${target}:.*check-tenant-service-admission`, "m"), target);
  }
  for (const target of ["mail", "discord", "tui", "tui-run", "app-shell"]) {
    assert.match(makefile, new RegExp(`^${target}:.*check-tenant-foreground-admission`, "m"), target);
  }
});

test("runtime labels are bound to the shell handoff", () => {
  const makefile = readFileSync(MAKEFILE, "utf8");
  assert.match(makefile, /--label "baxter\.tenant=\$\(BAXTER_TENANT_ID\)"/);
  assert.match(makefile, /--label "baxter\.transaction=\$\(BAXTER_SHELL_TRANSACTION\)"/);
  assert.match(makefile, /\/bin\/sh app\/scripts\/tenant-admission\.sh foreground/);
  assert.match(makefile, /\/bin\/sh app\/scripts\/tenant-admission\.sh service/);
  assert.doesNotMatch(makefile, /(^|[^/]\b)sh app\/scripts\/set-env-var\.sh/m);
});

function admission(mode: "service" | "foreground", extra: NodeJS.ProcessEnv = {}, extraFd?: number) {
  return spawnSync("/bin/sh", [join(CORE, "app", "scripts", "tenant-admission.sh"), mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      BAXTER_TENANT_ID: "acme",
      TENANT_ENV: "/agents/acme/app.env",
      TENANT_STATE: "/agents/acme/state",
      PROJECT: "baxter-acme",
      ...(mode === "foreground" ? {
        BAXTER_SHELL_OPERATION: "shell",
        BAXTER_SHELL_TRANSACTION: "tx-test",
        BAXTER_SHELL_CONTROL_ROOT: "/var/lib/baxter-control/disk-quota",
      } : {}),
      ...extra,
    },
    stdio: extraFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", extraFd],
  });
}

function foreground(extra: NodeJS.ProcessEnv = {}, extraFd?: number) {
  return admission("foreground", extra, extraFd);
}

test("direct canonical detached runtime refuses outside matching systemd cgroup", () => {
  const result = admission("service");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /systemctl\/baxctl/);
});

test("symlink-parent aliases to canonical tenant seams refuse in service and foreground modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-admission-symlink-parent-"));
  const tenantAlias = join(dir, "acme-link");
  symlinkSync("/agents/acme", tenantAlias);

  try {
    for (const mode of ["service", "foreground"] as const) {
      const result = admission(mode, {
        TENANT_ENV: join(tenantAlias, "app.env"),
        TENANT_STATE: join(tenantAlias, "state"),
      });
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, /noncanonical writable \/agents seam/, mode);
      assert.doesNotMatch(result.stderr, /canonical detached runtime|owner-fence descriptor/, mode);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone development seams remain outside fleet admission", () => {
  for (const mode of ["service", "foreground"] as const) {
    const result = admission(mode, {
      BAXTER_TENANT_ID: "",
      TENANT_ENV: "app/.env",
      TENANT_STATE: "",
      PROJECT: "core",
    });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
  }
});

test("foreground refuses environment-only and identity-mismatch forgeries", () => {
  const missing = foreground();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /owner-fence descriptor/);
  const mismatch = foreground({ BAXTER_TENANT_ID: "beta" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /disagree/);
});

test("foreground refuses an arbitrary writable regular descriptor", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-fd-forgery-"));
  const path = join(dir, "fake-fence");
  writeFileSync(path, "{}");
  const fd = openSync(path, "r+");
  const result = foreground({ BAXTER_OWNER_FENCE_FD: "3" }, fd);
  closeSync(fd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root:root 0600|read-only|canonical control area/);
  rmSync(dir, { recursive: true, force: true });
});

test("service and foreground admission ignore caller PATH executables", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-admission-path-"));
  const marker = join(dir, "invoked");
  for (const name of ["sh", "grep", "node"]) {
    const fake = join(dir, name);
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 0\n`);
    chmodSync(fake, 0o755);
  }
  const poisoned = { PATH: dir };
  const service = spawnSync("/bin/sh", [join(CORE, "app", "scripts", "tenant-admission.sh"), "service"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...poisoned,
      BAXTER_TENANT_ID: "acme",
      TENANT_ENV: "/agents/acme/app.env",
      TENANT_STATE: "/agents/acme/state",
      PROJECT: "baxter-acme",
    },
  });
  assert.notEqual(service.status, 0);
  assert.match(service.stderr, /systemctl\/baxctl/);

  const arbitrary = join(dir, "arbitrary-fence");
  writeFileSync(arbitrary, "{}", { mode: 0o600 });
  const fd = openSync(arbitrary, "r");
  const foregroundResult = foreground({ ...poisoned, BAXTER_OWNER_FENCE_FD: "3" }, fd);
  closeSync(fd);
  assert.notEqual(foregroundResult.status, 0);
  assert.equal(requireExists(marker), false);
  rmSync(dir, { recursive: true, force: true });
});

test("set-env-var refuses a canonical tenant app.env before temp-file mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-env-admission-"));
  const marker = join(dir, "marker");
  const fakeMktemp = join(dir, "mktemp");
  writeFileSync(fakeMktemp, `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
  chmodSync(fakeMktemp, 0o755);
  const result = spawnSync("/bin/sh", [SET_ENV, "/agents/acme/app.env", "FOO", "bar"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /baxctl setenv/);
  assert.equal(readFileSync(fakeMktemp, "utf8").includes("touch"), true);
  assert.equal(requireExists(marker), false);
  rmSync(dir, { recursive: true, force: true });
});

test("set-env-var refuses resolved canonical traversal, separators, and symlinked parents", {
  skip: process.getuid?.() !== 0,
}, () => {
  const agentsExisted = existsSync("/agents");
  const tenant = `t7-${process.pid}`;
  const tenantRoot = join("/agents", tenant);
  const env = join(tenantRoot, "app.env");
  const dir = mkdtempSync(join(tmpdir(), "core-env-resolved-"));
  const marker = join(dir, "writer-invoked");
  const linkedAgents = join(dir, "linked-agents");
  mkdirSync(tenantRoot, { recursive: true });
  writeFileSync(env, "FOO=original\n", { mode: 0o600 });
  symlinkSync("/agents", linkedAgents);
  for (const name of ["mktemp", "awk", "mv"]) {
    const fake = join(dir, name);
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 99\n`);
    chmodSync(fake, 0o755);
  }

  try {
    for (const path of [
      `/agents/${tenant}/../${tenant}/app.env`,
      `/agents//${tenant}/app.env`,
      join(linkedAgents, tenant, "app.env"),
    ]) {
      const result = spawnSync("/bin/sh", [SET_ENV, path, "FOO", "changed"], {
        encoding: "utf8",
        env: { ...process.env, PATH: dir },
      });
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /baxctl setenv/, path);
      assert.equal(readFileSync(env, "utf8"), "FOO=original\n", path);
      assert.equal(requireExists(marker), false, path);
      assert.deepEqual(readdirSync(tenantRoot), ["app.env"], path);
    }
  } finally {
    rmSync(tenantRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    if (!agentsExisted) rmdirSync("/agents");
  }
});

function requireExists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}

function runDirectOllama(volume: (dir: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "core-ollama-admission-"));
  const dockerMarker = join(dir, "docker-invoked");
  const fakeDocker = join(dir, "docker");
  const fakeOllama = join(dir, "ollama");
  const fakeCurl = join(dir, "curl");
  writeFileSync(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dockerMarker}'\n`);
  writeFileSync(fakeOllama, "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf 'NAME ID SIZE MODIFIED\\nfake-model id 1GB now\\n'; fi\n");
  writeFileSync(fakeCurl, "#!/bin/sh\ncase \"$*\" in */api/ps*) printf '{\"context_length\":8192}\\n' ;; esac\n");
  for (const path of [fakeDocker, fakeOllama, fakeCurl]) chmodSync(path, 0o755);

  try {
    const appConfigVolume = volume(dir);
    const result = spawnSync("/bin/bash", [OLLAMA], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        APP_IMAGE: "fake-image",
        APP_CONFIG_VOLUME: appConfigVolume,
        OLLAMA_MODEL: "fake-model",
      },
    });
    const dockerInvocations = existsSync(dockerMarker)
      ? readFileSync(dockerMarker, "utf8").trim().split("\n")
      : [];
    return { appConfigVolume, dockerInvocations, result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("direct Ollama refuses canonical APP_CONFIG_VOLUME roots before Docker", () => {
  for (const volume of ["/agents", "/agents/acme/state"]) {
    const { dockerInvocations, result } = runDirectOllama(() => volume);
    assert.notEqual(result.status, 0, volume);
    assert.match(result.stderr, /refusing canonical \/agents writable mount/, volume);
    assert.deepEqual(dockerInvocations, [], volume);
  }
});

test("direct Ollama refuses an APP_CONFIG_VOLUME resolving into a canonical tenant root before Docker", () => {
  const { dockerInvocations, result } = runDirectOllama((dir) => {
    const agentsAlias = join(dir, "agents-link");
    symlinkSync("/agents", agentsAlias);
    return join(agentsAlias, "acme", "state");
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing canonical \/agents writable mount/);
  assert.deepEqual(dockerInvocations, []);
});

test("direct Ollama fails closed when APP_CONFIG_VOLUME cannot be safely resolved", () => {
  const { dockerInvocations, result } = runDirectOllama((dir) => {
    const loop = join(dir, "volume-loop");
    symlinkSync(loop, loop);
    return loop;
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot safely resolve APP_CONFIG_VOLUME/);
  assert.deepEqual(dockerInvocations, []);
});

test("direct Ollama preserves standalone named APP_CONFIG_VOLUME support", () => {
  const { dockerInvocations, result } = runDirectOllama(() => "baxter-app-config");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dockerInvocations.length, 2);
  assert.match(dockerInvocations[1], /-v baxter-app-config:\/home\/node/);
});

test("set-env-var preserves standalone noncanonical development", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-env-standalone-"));
  const env = join(dir, ".env");
  writeFileSync(env, "FOO=old\n");
  const result = spawnSync("/bin/sh", [SET_ENV, env, "FOO", "new"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(env, "utf8"), "FOO=new\n");
  rmSync(dir, { recursive: true, force: true });
});

test("set-key passes shell breakout syntax as a literal standalone value", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-set-key-literal-"));
  const env = join(dir, ".env");
  const marker = join(dir, "injected");
  const payload = `x'; /usr/bin/touch '${marker}'; #'`;
  writeFileSync(env, "OPENAI_API_KEY=old\n");

  try {
    const result = spawnSync("make", [
      "-C", CORE,
      "set-key",
      `TENANT_ENV=${env}`,
      "TYPE=openai",
      `KEY=${payload}`,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, "KEY payload executed a marker command");
    assert.equal(readFileSync(env, "utf8"), `OPENAI_API_KEY=${payload}\n`);

    const makefile = readFileSync(MAKEFILE, "utf8");
    const recipe = makefile.match(/^set-key:\n([\s\S]*?)^use-custom:/m)?.[1];
    assert.ok(recipe, "set-key recipe not found");
    assert.doesNotMatch(recipe, /\$\(KEY\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
