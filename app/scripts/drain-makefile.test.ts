import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const coreRoot = join(import.meta.dirname, "..", "..");
const makefilePath = join(coreRoot, "Makefile");
const makefile = readFileSync(makefilePath, "utf8");

function findProgram(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is not on PATH`);
}

const make = findProgram("make");

test("drain loop prints a zero-lease predicate value for its shell comparison", () => {
  assert.match(makefile, /process\.stdout\.write\(JSON\.parse\(s\)\.leaseCount===0\?\\"0\\":\\"1\\"\)/);
  assert.match(makefile, /status="\$\$\(\$\(DRAIN_CLI\) status\)" \|\| status=/);
});

function targetRecipe(name: string, nextName: string): string {
  const start = makefile.indexOf(`\n${name}:`);
  const end = makefile.indexOf(`\n${nextName}:`, start);
  assert.notEqual(start, -1, `${name} target should exist`);
  assert.notEqual(end, -1, `${nextName} target should delimit ${name}`);
  return makefile.slice(start, end);
}

test("every standalone drain command preflights its app image before its lifecycle lock", () => {
  for (const [name, nextName] of [["drain", "clear-drain"], ["clear-drain", "recover-drain"], ["recover-drain", "build-dev"]]) {
    const recipe = targetRecipe(name, nextName);
    const preflight = recipe.indexOf("$(ENSURE_DRAIN_IMAGE)");
    assert.ok(preflight >= 0, `${name} should preflight its drain image`);
    assert.ok(preflight < recipe.indexOf("flock -x"), `${name} should build before taking the lifecycle lock`);
    assert.ok(preflight < recipe.indexOf("$(DRAIN_CLI)"), `${name} should build before running drain-cli`);
  }
});

type Fixture = {
  image: string;
  lifecycleLock: string;
  root: string;
  state: string;
  tenantState: string;
  tenantEnv: string;
  env: NodeJS.ProcessEnv;
};

type CommandResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "baxter-drain-makefile-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin);
  mkdirSync(state);
  const tenant = join(root, "tenant");
  mkdirSync(tenant);
  const tenantEnv = join(tenant, "app.env");
  writeFileSync(tenantEnv, "");
  writeFileSync(join(state, "events"), "");

  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/sh
set -eu
state="\${FAKE_DOCKER_STATE:?}"
events="$state/events"

case "$1" in
  version)
    printf '%s\\n' arm64
    ;;
  image)
    printf 'image-inspect:%s\\n' "$3" >> "$events"
    if [ -e "$state/image" ]; then exit 0; fi
    sleep "\${FAKE_DOCKER_INSPECT_DELAY:-0}"
    exit 1
    ;;
  build)
    shift
    tag=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -t ]; then
        tag="$2"
        shift 2
      else
        shift
      fi
    done
    if [ -z "$tag" ]; then
      printf '%s\\n' buildkit-check >> "$events"
      exit 0
    fi
    printf 'build:%s:start\\n' "$tag" >> "$events"
    if [ "\${FAKE_DOCKER_BUILD_FAIL:-0}" = 1 ]; then exit 42; fi
    sleep "\${FAKE_DOCKER_BUILD_DELAY:-0}"
    : > "$state/image"
    printf 'build:%s:end\\n' "$tag" >> "$events"
    ;;
  run)
    printf '%s\\n' drain-cli >> "$events"
    ;;
  stop)
    printf 'stop:%s\\n' "$2" >> "$events"
    ;;
  *)
    printf 'docker:%s\\n' "$1" >> "$events"
    ;;
esac
`);
  chmodSync(docker, 0o755);

  const flockWrapper = join(bin, "flock");
  writeFileSync(flockWrapper, `#!/bin/sh
set -eu
if [ "$2" = "$FAKE_CORE_ROOT" ]; then lock="$FAKE_DOCKER_STATE/core-lock"; else lock="$FAKE_DOCKER_STATE/lifecycle-lock"; fi
printf 'flock:%s\\n' "$2" >> "$FAKE_DOCKER_STATE/events"
while ! mkdir "$lock" 2>/dev/null; do sleep 0.01; done
trap 'rmdir "$lock"' EXIT
shift 2
"$@"
`);
  chmodSync(flockWrapper, 0o755);

  return {
    image: "baxter-drain-preflight-test",
    lifecycleLock: join(root, "lifecycle.lock"),
    root,
    state,
    tenantState: join(root, "tenant-state"),
    tenantEnv,
    env: {
      ...process.env,
      FAKE_CORE_ROOT: coreRoot,
      FAKE_DOCKER_STATE: state,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

function makeArgs(fixture: Fixture, target: string, lifecycleLock = fixture.lifecycleLock): string[] {
  return [
    "-f", makefilePath,
    target,
    `APP_IMAGE=${fixture.image}`,
    "PROJECT=baxter-drain-preflight-test",
    `TENANT_ENV=${fixture.tenantEnv}`,
    `TENANT_STATE=${fixture.tenantState}`,
    ...(lifecycleLock ? [`LIFECYCLE_LOCK=${lifecycleLock}`] : []),
  ];
}

function runMake(
  fixture: Fixture,
  target: string,
  env: NodeJS.ProcessEnv = fixture.env,
  lifecycleLock = fixture.lifecycleLock,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(make, makeArgs(fixture, target, lifecycleLock), { cwd: coreRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

function events(fixture: Fixture): string[] {
  return readFileSync(join(fixture.state, "events"), "utf8").split("\n").filter(Boolean);
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { force: true, recursive: true });
}

test("the default lifecycle lock is the stable tenant env parent directory", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(join(fixture.state, "image"), "present");
    const result = await runMake(fixture, "clear-drain", fixture.env, "");
    assert.equal(result.code, 0, result.stderr);
    assert.ok(events(fixture).includes(`flock:${dirname(fixture.tenantEnv)}`), events(fixture).join("\n"));
  } finally {
    cleanup(fixture);
  }
});

test("concurrent missing-image preflights build once before either lifecycle lock", async () => {
  const fixture = createFixture();
  try {
    const env = {
      ...fixture.env,
      FAKE_DOCKER_BUILD_DELAY: "0.25",
      FAKE_DOCKER_INSPECT_DELAY: "0.25",
    };
    const [first, second] = await Promise.all([
      runMake(fixture, "clear-drain", env),
      runMake(fixture, "clear-drain", env),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);

    const log = events(fixture);
    const builds = log.filter((event) => event === `build:${fixture.image}:start`);
    assert.equal(builds.length, 1, log.join("\n"));

    const buildIndex = log.indexOf(builds[0]!);
    assert.ok(log.indexOf(`flock:${coreRoot}`) < buildIndex, log.join("\n"));
    const lifecycleLocks = log
      .map((event, index) => event === `flock:${fixture.lifecycleLock}` ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(lifecycleLocks.length, 2, log.join("\n"));
    assert.ok(lifecycleLocks.every((index) => index > buildIndex), log.join("\n"));
  } finally {
    cleanup(fixture);
  }
});

test("a present app image skips the drain-image build", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(join(fixture.state, "image"), "present");
    const result = await runMake(fixture, "clear-drain");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(events(fixture).filter((event) => event.startsWith(`build:${fixture.image}:`)).length, 0);
  } finally {
    cleanup(fixture);
  }
});

test("recover-drain does not stop containers or acquire its lifecycle lock when its image build fails", async () => {
  const fixture = createFixture();
  try {
    const result = await runMake(fixture, "recover-drain", {
      ...fixture.env,
      FAKE_DOCKER_BUILD_FAIL: "1",
    });
    assert.notEqual(result.code, 0, result.stderr);

    const log = events(fixture);
    assert.ok(log.includes(`build:${fixture.image}:start`), log.join("\n"));
    assert.ok(!log.some((event) => event.startsWith("stop:")), log.join("\n"));
    assert.ok(!log.includes(`flock:${fixture.lifecycleLock}`), log.join("\n"));
    assert.ok(!log.includes("drain-cli"), log.join("\n"));
  } finally {
    cleanup(fixture);
  }
});
