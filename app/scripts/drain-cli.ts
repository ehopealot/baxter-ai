#!/usr/bin/env node
// Local operator CLI for the shared durable drain marker. It deliberately has no
// network listener: Docker's exec/run permission is the authentication boundary.
import { beginDrain, clearDrain, drainStatus, recoverDrain } from "./drain.ts";

async function main(argv: string[]): Promise<void> {
  const command = argv[2];
  let status;
  switch (command) {
    case "begin": status = await beginDrain(); break;
    case "status": status = await drainStatus(); break;
    case "clear": status = await clearDrain({ force: argv.includes("--force") }); break;
    case "recover": status = await recoverDrain(); break;
    default: throw new Error("usage: drain-cli.ts <begin|status|clear [--force]|recover>");
  }
  console.log(JSON.stringify({ ...status, leaseCount: Object.keys(status.leases).length }));
}

main(process.argv).catch((err) => { console.error(`drain-cli: ${(err as Error).message}`); process.exitCode = 1; });
