import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFullBufferSync, type BufferWriteSync } from "./write-full-buffer.ts";

test("writeFullBufferSync loops partial writes without dropping any bytes", () => {
  const source = Buffer.from("mail and SMS transcript row\n");
  const observed: Buffer[] = [];
  const writer: BufferWriteSync = (_fd, buffer, offset, length, position) => {
    assert.equal(position, null);
    const written = Math.min(3, length);
    observed.push(Buffer.from(buffer.subarray(offset, offset + written)));
    return written;
  };
  writeFullBufferSync(1, source, writer);
  assert.equal(Buffer.concat(observed).toString("utf8"), source.toString("utf8"));
  assert.ok(observed.length > 1);
});

test("writeFullBufferSync rejects a writer that makes no progress", () => {
  assert.throws(() => writeFullBufferSync(1, Buffer.from("row\n"), () => 0), /made no progress/);
});
