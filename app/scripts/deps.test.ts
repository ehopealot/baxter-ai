import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkg = JSON.parse(readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json"), "utf8"));

test("resend + chat sdk deps present and exact-pinned", () => {
  const deps = { ...pkg.dependencies };
  for (const name of ["chat", "@resend/chat-sdk-adapter", "@chat-adapter/shared", "resend", "better-sqlite3"]) {
    assert.ok(deps[name], `missing dependency: ${name}`);
    assert.ok(!/^[\^~]/.test(deps[name]), `${name} must be pinned exactly (no ^/~): ${deps[name]}`);
  }
});
