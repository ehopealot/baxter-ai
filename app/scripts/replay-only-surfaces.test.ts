import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";
import { isSmsOptedOut } from "./sms-opt-out.ts";
import { main as smsMain } from "./sms-bot.ts";
import { main as chatMain } from "./chat-bot.ts";
import { main as mailMain } from "./mail-bot.ts";

const keys = { tenant: "tenant-replay", endpoint: "https://home.example.test", accessKeyId: "key", secretAccessKey: "secret" };

function admission(root: string, queue: "mail" | "sms" | "chat", outcomeType: string, outcome: unknown): QueueAdmissionOutbox {
  const outbox = new QueueAdmissionOutbox(join(root, `${queue}-outbox.json`));
  const workId = admissionWorkId(queue, 7, keys.tenant);
  outbox.admit({ tenantId: keys.tenant, queue, sequence: 7, workId, admittedAt: "2026-01-01T00:00:00.000Z",
    variant: "non-agent-terminal", outcomeType, outcomeVersion: 1, outcome,
    idempotencyKey: `${outcomeType}:${workId}`, state: "pending-side-effects" });
  return outbox;
}

test("mail/SMS/chat replay-only mains finish source effects and publish durable cursor coverage before return", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-only-surfaces-"));
  const common = { loadHomeKeys: () => keys, log: () => {}, logErr: () => {}, replayOnly: true as const };
  try {
    const smsAdmissions = admission(root, "sms", "sms-stop", { from: "+15551234567", content: "STOP" });
    const smsEvents: string[] = [];
    const smsEnv = { SMS_OPT_OUT_PATH_OVERRIDE: join(root, "sms-opt-outs.json") };
    await smsMain({ ...common, env: smsEnv, admissions: smsAdmissions,
      cursorLoad: () => -1, cursorStore: value => { smsEvents.push(`cursor:${value}`); },
      onDurableProgress: value => { smsEvents.push(`coverage:${value}`); },
    });
    assert.equal(isSmsOptedOut("+15551234567", smsEnv), true);
    assert.deepEqual(smsEvents, ["cursor:7", "coverage:7"]);
    assert.deepEqual(smsAdmissions.records(), [], "covered STOP terminal is compacted before replay-only return");

    const chatAdmissions = admission(root, "chat", "chat-create", { kind: "create-chat" });
    const chatEvents: string[] = [];
    await chatMain({ ...common, env: {}, admissions: chatAdmissions,
      cursorLoad: () => -1, cursorStore: value => { chatEvents.push(`cursor:${value}`); },
      onDurableProgress: value => { chatEvents.push(`coverage:${value}`); },
    });
    assert.deepEqual(chatEvents, ["cursor:7", "coverage:7"]);
    assert.deepEqual(chatAdmissions.records(), []);

    const mailAdmissions = admission(root, "mail", "mail-no-agent-dispatch", { reason: "handled-without-agent-dispatch" });
    const mailEvents: string[] = [];
    await mailMain({ ...common, env: { BAXTER_EMAIL: "baxter@example.test" }, admissions: mailAdmissions,
      cursorLoad: () => -1, cursorStore: value => { mailEvents.push(`cursor:${value}`); },
      onDurableProgress: value => { mailEvents.push(`coverage:${value}`); },
    });
    assert.deepEqual(mailEvents, ["cursor:7", "coverage:7"]);
    assert.deepEqual(mailAdmissions.records(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
