import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compose = readFileSync(fileURLToPath(new URL("../../compose.yaml", import.meta.url)), "utf8");
const makefile = readFileSync(fileURLToPath(new URL("../../Makefile", import.meta.url)), "utf8");

test("core has only remote code execution and a Unix signer profile", () => {
  assert.doesNotMatch(compose, /^  codapi:/m);
  assert.match(compose, /code-executor-signer:\n[\s\S]*?profiles: \["remote-code"\]/);
  assert.match(compose, /CODE_EXECUTOR_SIGNER_ENV/);
  assert.match(compose, /cap_add: \[CHOWN, FOWNER, SETGID, SETUID\]/);
  assert.match(compose, /install -d -m 0770 -o 0 -g 1000 \/run\/code-executor/);
  assert.match(compose, /code-executor-socket:\/run\/code-executor/);
  assert.doesNotMatch(compose, /CODAPI_|depends_on: \[codapi\]|docker\.sock/);
  assert.match(makefile, /check-code-executor/);
  assert.match(makefile, /remote-code/);
  assert.doesNotMatch(makefile, /build-codapi|^codapi:/m);
});
