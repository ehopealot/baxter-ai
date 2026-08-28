import type { QueueName, NonAgentTerminalRecord } from "./queue-admission-outbox.ts";
import { QueueAdmissionOutbox } from "./queue-admission-outbox.ts";
import { deadLetter } from "./dead-letter.ts";
import { setSmsOptOut } from "./sms-opt-out.ts";

export interface QueueReplayDeps {
  admissions: QueueAdmissionOutbox;
  queue: QueueName;
  tenantId?: string;
  cursorLoad: () => number;
  cursorStore: (highWater: number) => void;
  env?: NodeJS.ProcessEnv;
  deadLetter?: typeof deadLetter;
  setSmsOptOut?: typeof setSmsOptOut;
  now?: () => Date;
}

function scoped(record: NonAgentTerminalRecord, queue: QueueName, tenantId?: string): boolean {
  return record.queue === queue && record.tenantId === tenantId;
}

/**
 * Finish source-owned effects before a queue's agent scheduler starts, then
 * advance its durable source cursor through every already-admitted envelope.
 * All effects are idempotent: STOP republishes the opt-out state and mail DLQ
 * replay is deduplicated by outcomeId; the remaining records were admitted only
 * after their source mutation or DLQ append had completed.
 */
export async function replayQueueBeforeAgents(deps: QueueReplayDeps): Promise<number> {
  const pending = deps.admissions.records()
    .filter((record): record is NonAgentTerminalRecord => record.variant === "non-agent-terminal"
      && record.state === "pending-side-effects" && scoped(record, deps.queue, deps.tenantId))
    .sort((left, right) => left.sequence - right.sequence);

  for (const record of pending) {
    const completedAt = (deps.now ?? (() => new Date()))().toISOString();
    switch (`${record.queue}:${record.outcomeType}`) {
      case "sms:sms-stop": {
        const outcome = record.outcome as { from?: unknown } | null;
        if (!outcome || typeof outcome.from !== "string" || outcome.from === "") throw new Error("invalid durable SMS STOP outcome");
        await (deps.setSmsOptOut ?? setSmsOptOut)(outcome.from, true, deps.env ?? process.env);
        deps.admissions.completeNonAgent(record.workId, { kind: "sms-opt-out", phone: outcome.from }, completedAt);
        break;
      }
      case "sms:sms-transcript-poison":
        // The source DLQ append precedes classification for SMS poison rows.
        deps.admissions.completeNonAgent(record.workId, { kind: "source-dead-letter", surface: "sms", recordedAt: completedAt }, completedAt);
        break;
      case "chat:chat-create":
        deps.admissions.completeNonAgent(record.workId, { kind: "source-applied", surface: "chat", detail: "create-chat" }, completedAt);
        break;
      case "chat:chat-delete":
        deps.admissions.completeNonAgent(record.workId, { kind: "source-applied", surface: "chat", detail: "delete-chat" }, completedAt);
        break;
      case "chat:chat-transcript-poison":
      case "chat:chat-no-agent-dispatch":
        // The source DLQ append precedes classification for Chat poison rows.
        deps.admissions.completeNonAgent(record.workId, { kind: "source-dead-letter", surface: "chat", recordedAt: completedAt }, completedAt);
        break;
      case "mail:mail-no-agent-dispatch":
        deps.admissions.completeNonAgent(record.workId, { kind: "source-applied", surface: "mail", detail: "handled-without-agent-dispatch" }, completedAt);
        break;
      case "mail:mail-source-dead-letter":
        // Mail admits before appending its DLQ row. Replaying the admission record
        // preserves the failure even for legacy rows whose outcome lacks raw input.
        (deps.deadLetter ?? deadLetter)("mail", {
          outcomeId: record.workId,
          id: record.sequence,
          workId: record.workId,
          at: record.admittedAt,
          kind: "replayed-source-failure",
          admissionOutcome: record.outcome,
        });
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
