import { writeSync } from "node:fs";

export type BufferWriteSync = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => number;

/** Write every byte or fail; synchronous append writes may legally be partial. */
export function writeFullBufferSync(fd: number, bytes: Uint8Array, writer: BufferWriteSync = writeSync): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error("buffer write made no progress");
    offset += written;
  }
}
