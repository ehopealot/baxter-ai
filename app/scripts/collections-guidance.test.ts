import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dirname, "..");
const readApp = (relative: string): string => readFileSync(join(APP_DIR, relative), "utf8");
const normalizeGuidance = (source: string): string => source.replace(/\s+/g, " ");

test("the Collections skill defines a JSON list with visible Markdown and Baxter-only notes", () => {
  const skill = normalizeGuidance(readApp("skills/collections/SKILL.md"));
  assert.match(skill, /category/i);
  assert.match(skill, /JSON/i);
  assert.match(skill, /"title"/i);
  assert.match(skill, /"content"/i);
  assert.match(skill, /"notes"/i);
  assert.match(skill, /Markdown/i);
  assert.match(skill, /(?:each|every) (?:JSON )?(?:entry|object) is exactly one (?:real )?item/i, "skill: one entry per item");
  assert.match(skill, /peer items?\s+in\s+separate\s+JSON\s+(?:entries|objects)/i, "skill: peer items are separate entries");
  assert.match(skill, /(?:never|not)\s+(?:as\s+)?a\s+Markdown\s+list\s+inside\s+(?:one\s+)?entry/i, "skill: peer items are not packed into a Markdown list");
  assert.match(skill, /Markdown list.*(?:fine|valid|allowed).*detail.*(?:one )?item/i, "skill: a detail list remains allowed");
  assert.match(skill, /when unsure[\s\S]*(?:finer|separate)\s+(?:entry|entries)/i, "skill: ambiguous categories prefer separate entries");
  assert.match(skill, /Baxter-only|internal/i);
  assert.match(skill, /user-(provided|supplied).*title.*content/is);
  assert.match(skill, /proactiv/i);
  assert.match(skill, /existing.*duplicate/is);
  assert.match(skill, /one-off|speculative/i);
  assert.match(skill, /## Example[\s\S]*```json/i);
  assert.match(skill, /collections-cli delete <slug> --expect <version>/i, "skill: CAS delete command");
  assert.match(skill, /(?:clear|explicit) user request/i, "skill: deletion requires a user request");
  assert.match(skill, /irreversible|cannot be undone/i, "skill: deletion safety is explicit");
  assert.doesNotMatch(skill, /<comment>/i);
  assert.doesNotMatch(skill, /focused working document for one ongoing effort/i);
});

test("every Collection prompt template gives compact JSON, visible-fields, and atomic-entry guidance", () => {
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
    const guidance = normalizeGuidance(readApp(source));
    assert.match(guidance, /categor(y|ies)/i, `${source}: category guidance`);
    assert.match(guidance, /JSON/i, `${source}: JSON format guidance`);
    assert.match(guidance, /title.*content.*notes/is, `${source}: entry fields guidance`);
    assert.match(guidance, /Baxter-only|internal/i, `${source}: private notes guidance`);
    assert.match(guidance, /each entry is exactly one item/i, `${source}: one entry per item`);
    assert.match(guidance, /peer items?\s+in\s+separate\s+JSON\s+(?:entries|objects)/i, `${source}: peer items are separate entries`);
    assert.match(guidance, /(?:never|not)\s+(?:as\s+)?a\s+Markdown\s+list\s+inside\s+(?:one\s+)?entry/i, `${source}: peer items are not packed into a Markdown list`);
    assert.match(guidance, /Markdown list.*(?:fine|valid|allowed).*detail.*(?:one )?item/i, `${source}: a detail list remains allowed`);
    assert.doesNotMatch(guidance, /<comment>/i, `${source}: retired comment convention`);
    assert.match(guidance, /proactiv|don't wait to be asked/i, `${source}: proactive creation`);
    assert.match(guidance, /existing|duplicate/i, `${source}: check-before-create`);
    assert.match(guidance, /one-off|speculative|noise/i, `${source}: creation restraint`);
    assert.doesNotMatch(guidance, /focused working document for one ongoing effort/i, `${source}: obsolete narrow definition`);
  }
});
