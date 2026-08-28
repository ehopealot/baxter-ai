import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function fullAncestry(path: string): string[] {
  const ancestry: string[] = [];
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    ancestry.push(cursor);
    if (dirname(cursor) === cursor) return ancestry.reverse();
  }
}

function child(moduleUrl: string, target: string): Promise<string[]> {
  const code = `
    import { closeSync, fsyncSync, openSync } from "node:fs";
    const durable = await import(${JSON.stringify(moduleUrl)});
    const synced = [];
    durable.setDurableDirectorySyncForTest(path => {
      synced.push(path);
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    });
    durable.ensureDurableDirectory(${JSON.stringify(target)});
    console.log(JSON.stringify(synced));
  `;
  return new Promise((resolveResult, reject) => {
    execFile(process.execPath, ["--input-type=module", "--eval", code], (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolveResult(JSON.parse(stdout.trim()));
    });
  });
}

test("independent processes each complete full ancestry when racing directory bootstrap", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-directory-process-"));
  const target = join(root, "state", "mail", "shared");
  const moduleUrl = new URL("./durable-directory.ts", import.meta.url).href;
  try {
    const results = await Promise.all([child(moduleUrl, target), child(moduleUrl, target)]);
    assert.deepEqual(results, [fullAncestry(target), fullAncestry(target)], "an existing path in the losing process does not skip its barrier");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
