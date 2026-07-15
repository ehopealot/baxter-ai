#!/usr/bin/env node
// Token-less boundary CLI for the offline codapi sandbox. The spawned claude
// run reaches code execution only through this (Bash(code-cli *)); no secret
// lives here -- it's a scoping/convenience layer over codapi's HTTP API. Raw
// fetch, no deps.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CODAPI_URL = process.env.CODAPI_URL || "http://codapi:1313";
// Our lang name == codapi sandbox name (no version resolution needed).
const SANDBOXES = new Set(["python", "node"]);

export function parseArgs(argv) {
  const [lang, ...rest] = argv;
  const opts = { lang, file: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") opts.file = rest[++i];
  }
  return opts;
}

export function buildRequestBody({ sandbox, content }) {
  return { sandbox, command: "run", files: { "": content } };
}

// codapi /v1/exec response: { id, ok, duration, stdout, stderr }.
export function formatResult(res) {
  const parts = [];
  if (res.stdout) parts.push(res.stdout.replace(/\n$/, ""));
  if (res.stderr) parts.push(`[stderr]\n${res.stderr.replace(/\n$/, "")}`);
  parts.push(res.ok ? "[ok]" : "[error]");
  return parts.join("\n");
}
