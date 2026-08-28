import type { QueueName, NonAgentTerminalRecord, StoredChatSourceDeadLetter, StoredMailSourceDeadLetter, StoredSmsSourceDeadLetter } from "./queue-admission-outbox.ts";
import { QueueAdmissionOutbox } from "./queue-admission-outbox.ts";
import { deadLetter } from "./dead-letter.ts";
import { setSmsOptOut } from "./sms-opt-out.ts";
import { createChat, deleteChat } from "./chat-transcript.ts";

export interface QueueReplayDeps {
  admissions: QueueAdmissionOutbox;
  queue: QueueName;
  tenantId?: string;
  cursorLoad: () => number;
  cursorStore: (highWater: number) => void;
  env?: NodeJS.ProcessEnv;
  deadLetter?: typeof deadLetter;
  setSmsOptOut?: typeof setSmsOptOut;
  createChat?: typeof createChat;
  deleteChat?: typeof deleteChat;
  now?: () => Date;
}

function scoped(record: NonAgentTerminalRecord, queue: QueueName, tenantId?: string): boolean {
  return record.queue === queue && record.tenantId === tenantId;
}

/** Return the exact source-DLQ record made durable by mail admission. */
export function mailSourceDeadLetterRecord(record: NonAgentTerminalRecord): StoredMailSourceDeadLetter {
  const outcome = record.outcome;
  if (record.queue !== "mail" || record.outcomeType !== "mail-source-dead-letter" || record.outcomeVersion !== 2
    || !outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("invalid durable mail source DLQ outcome");
  }
  const dlq = outcome as Record<string, unknown>;
  const payload = dlq.payload as Record<string, unknown> | null;
  const headers = payload?.svixHeaders;
  if (Object.keys(dlq).length !== 5 || dlq.id !== record.sequence || dlq.workId !== record.workId
    || dlq.at !== record.admittedAt || typeof dlq.error !== "string"
    || !payload || Object.keys(payload).length !== 5 || payload.kind !== "mail" || payload.id !== record.sequence
    || payload.at !== record.admittedAt || typeof payload.raw !== "string"
    || !headers || typeof headers !== "object" || Array.isArray(headers)
    || !Object.values(headers).every(value => typeof value === "string")) {
    throw new Error("invalid durable mail source DLQ outcome");
  }
  return dlq as unknown as StoredMailSourceDeadLetter;
}

/**
 * Finish source-owned effects before a queue's agent scheduler starts, then
 * advance its durable source cursor through every already-admitted envelope.
 * All effects are idempotent: STOP republishes the opt-out state and mail DLQ
 * replay is deduplicated by workId; the remaining records were admitted only
 * after their source mutation or DLQ append had completed.
 */
export async function replayQueueBeforeAgents(deps: QueueReplayDeps): Promise<number> {
  const pending = deps.admissions.records()
    .filter((record): record is NonAgentTerminalRecord => record.variant === "non-agent-terminal"
      && record.state === "pending-side-effects" && scoped(record, deps.queue, deps.tenantId))
    .sort((left, right) => left.sequence - right.sequence);

  for (const record of pending) {
    const completedAt = (deps.now ?? (() => new Date()))().toISOString();
    switch (`${record.queue}:${record.outcomeType}@${record.outcomeVersion}`) {
      case "sms:sms-stop@1": {
        const outcome = record.outcome as { from: string; content: string };
        await (deps.setSmsOptOut ?? setSmsOptOut)(outcome.from, true, deps.env ?? process.env);
        deps.admissions.completeNonAgent(record.workId, { kind: "sms-opt-out", phone: outcome.from }, completedAt);
        break;
      }
      case "sms:sms-transcript-poison@1":
        (deps.deadLetter ?? deadLetter)("sms", record.outcome as StoredSmsSourceDeadLetter as unknown as Record<string, unknown>);
        deps.admissions.completeNonAgent(record.workId, { kind: "source-dead-letter", surface: "sms", recordedAt: completedAt }, completedAt);
        break;
      case "chat:chat-create@1":
        await (deps.createChat ?? createChat)(`wc-${record.sequence}`, record.admittedAt);
        deps.admissions.completeNonAgent(record.workId, { kind: "source-applied", surface: "chat", detail: "create-chat" }, completedAt);
        break;
      case "chat:chat-delete@1":
        await (deps.deleteChat ?? deleteChat)((record.outcome as { chatId: string }).chatId);
        deps.admissions.completeNonAgent(record.workId, { kind: "source-applied", surface: "chat", detail: "delete-chat" }, completedAt);
        break;
      case "chat:chat-transcript-poison@1":
        (deps.deadLetter ?? deadLetter)("chat", record.outcome as StoredChatSourceDeadLetter as unknown as Record<string, unknown>);
        deps.admissions.completeNonAgent(record.workId, { kind: "source-dead-letter", surface: "chat", recordedAt: completedAt }, completedAt);
        break;
      case "mail:mail-no-agent-dispatch@1":
        deps.admissions.completeNonAgent(record.workId, { kind: "source-applied", surface: "mail", detail: "handled-without-agent-dispatch" }, completedAt);
        break;
      case "mail:mail-source-dead-letter@2":
        // Mail admission owns the complete JSON-safe append input. Pass that
        // object through unchanged so restart cannot lose raw mail, headers, or error detail.
        (deps.deadLetter ?? deadLetter)("mail", mailSourceDeadLetterRecord(record) as unknown as Record<string, unknown>);
        deps.admissions.completeNonAgent(record.workId, { kind: "source-dead-letter", surface: "mail", recordedAt: completedAt }, completedAt);
        break;
      default:
        throw new Error(`unsupported pending non-agent outcome ${record.queue}:${record.outcomeType}@${record.outcomeVersion}`);
    }
  }

  // A crash may occur after admission/terminalization but before the source
  // cursor write. Ordered source drains make the highest retained admission a
  // safe cumulative high-water once every pending side effect above is terminal.
  let highWater = deps.cursorLoad();
  for (const record of deps.admissions.records()) {
    if (record.queue === deps.queue && record.tenantId === deps.tenantId) highWater = Math.max(highWater, record.sequence);
  }
  if (highWater >= 0) deps.cursorStore(highWater);
  return highWater;
}
