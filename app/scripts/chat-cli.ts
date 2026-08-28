#!/usr/bin/env node
import { reportSkip } from "./cli-flags.ts";
// The container-side reply/delivery surface Baxter shells to post a Home
// Chats reply. Mirrors sms-cli.ts's shape (stdin-read command, `import.meta.url`
// main guard, unknown/missing subcommand -> nonzero exit) but is deliberately
// thinner: chat has no external provider (no creds, no network, no daily-cap
// counter) -- the DO/browser is the surface, reached only via the shared
// chat-transcript.ts store. The chat-bot daemon's fs.watch (Task 3.2) is what
// turns this append into a `changed` ping to the link; chat-cli itself never
// touches the link.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appendMessage, type ChatMessage } from "./chat-transcript.ts";
import { completeOutput, completedProviderReceipts, outputReceiptsForWork, outputWorkId, prepareOutput, type ChatOutputOperation } from "./surface-output-receipts.ts";

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Mints a unique baxter message id -- NOT a path segment (the chat id `wc-<n>`
// is the directory; chat-transcript.ts's validateId only ever checks the chat
// id, never this), so any collision-resistant token works. Mirrors
// checklist-store.ts's newItemId() (randomBytes(8) hex) rather than
// `b-${Date.now()}`, which can collide within the same millisecond.
function mintBaxterId(): string {
  return `b-${randomBytes(8).toString("hex")}`;
}

// Appends a Baxter reply to the chat transcript. Exported so the CLI's "send"
// command and tests both go through the same path. Propagates appendMessage's
// throw when `chatId` has no index entry (Task 1.1's invariant) rather than
// swallowing it -- the caller (the main guard below) turns that into a
// nonzero exit, same as any other failure.
export async function sendReply(chatId: string, content: string, env: NodeJS.ProcessEnv = process.env): Promise<ChatMessage> {
  // Refuse a blank body loudly rather than publishing an empty bubble. SMS has
  // an accidental backstop here (Sendblue itself rejects an empty body), but
  // chat has no provider to catch it -- an unpiped/empty stdin (readStdin()
  // returns "") would otherwise append an empty message and exit 0, which is
  // exactly the silent-success shape the unknown-subcommand handling below
  // exists to prevent.
  if (!content.trim()) throw new Error("chat-cli send: empty message body (nothing on stdin?)");
  const workId = outputWorkId(env);
  if (workId) {
    const operation: ChatOutputOperation = { kind: "chat", chatId, content, authorName: PERSONA_NAME };
    const receipt = await prepareOutput("chat", workId, operation);
    const m: ChatMessage = {
      id: `b-${receipt.operationId.slice(0, 16)}`, at: receipt.preparedAt,
      authorId: "baxter", authorName: operation.authorName, content,
    };
    await appendMessage(chatId, m);
    await completeOutput("chat", workId, operation);
    return m;
  }
  const m: ChatMessage = { id: mintBaxterId(), at: new Date().toISOString(), authorId: "baxter", authorName: PERSONA_NAME, content };
  await appendMessage(chatId, m);
  return m;
}

/** Reconcile prepared local outputs before model replay. */
export async function replayChatOutputs(workId: string): Promise<Array<{ idempotencyKey: string; providerId: string }>> {
  for (const receipt of outputReceiptsForWork("chat", workId)) {
    if (receipt.state === "completed") continue;
    if (receipt.operation.kind !== "chat") throw new Error("invalid chat output receipt operation");
    await appendMessage(receipt.operation.chatId, {
      id: `b-${receipt.operationId.slice(0, 16)}`, at: receipt.preparedAt,
      authorId: "baxter", authorName: receipt.operation.authorName, content: receipt.operation.content,
    });
    await completeOutput("chat", workId, receipt.operation);
  }
  return completedProviderReceipts("chat", workId);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    try {
      if (cmd === "send") { console.log(JSON.stringify(await sendReply(rest[0], await readStdin()))); }
      else if (cmd === "skip") {
        const stdinText = await readStdin();
        reportSkip("chat", rest, stdinText);
      }
      else { console.error(`unknown command: ${cmd}`); process.exit(1); }
    } catch (err) { console.error(String(err)); process.exit(1); }
  })();
}
