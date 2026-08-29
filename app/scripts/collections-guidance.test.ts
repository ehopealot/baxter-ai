import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dirname, "..");
const readApp = (relative: string): string => readFileSync(join(APP_DIR, relative), "utf8");

test("the Collections skill defines a JSON list with visible Markdown and Baxter-only notes", () => {
  const skill = readApp("skills/collections/SKILL.md");
  assert.match(skill, /category/i);
  assert.match(skill, /JSON/i);
  assert.match(skill, /"title"/i);
  assert.match(skill, /"content"/i);
  assert.match(skill, /"notes"/i);
  assert.match(skill, /Markdown/i);
  assert.match(skill, /Baxter-only|internal/i);
  assert.match(skill, /user-(provided|supplied).*title.*content/is);
  assert.match(skill, /proactiv/i);
  assert.match(skill, /existing.*duplicate/is);
  assert.match(skill, /one-off|speculative/i);
  assert.match(skill, /## Example[\s\S]*```json/i);
  assert.doesNotMatch(skill, /<comment>/i);
  assert.doesNotMatch(skill, /focused working document for one ongoing effort/i);
});

test("every active surface gives compact JSON, visible-fields, and proactive Collection guidance", () => {
  const sources = [
    "prompt.md",
    "discord-prompt.md",
    "chat-prompt.md",
    "sms-prompt.md",
    "heartbeat-prompt.md",
    "tui-prompt.md",
    "discord-reaction-prompt.md",
  ];

  for (const source of sources) {
    const guidance = readApp(source);
    assert.match(guidance, /categor(y|ies)/i, `${source}: category guidance`);
    assert.match(guidance, /JSON/i, `${source}: JSON format guidance`);
    assert.match(guidance, /title.*content.*notes/is, `${source}: entry fields guidance`);
    assert.match(guidance, /Baxter-only|internal/i, `${source}: private notes guidance`);
    assert.doesNotMatch(guidance, /<comment>/i, `${source}: retired comment convention`);
    assert.match(guidance, /proactiv|don't wait to be asked/i, `${source}: proactive creation`);
    assert.match(guidance, /existing|duplicate/i, `${source}: check-before-create`);
    assert.match(guidance, /one-off|speculative|noise/i, `${source}: creation restraint`);
    assert.doesNotMatch(guidance, /focused working document for one ongoing effort/i, `${source}: obsolete narrow definition`);
  }
});
