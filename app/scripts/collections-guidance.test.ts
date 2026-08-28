import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dirname, "..");
const readApp = (relative: string): string => readFileSync(join(APP_DIR, relative), "utf8");

test("the Collections skill defines category-oriented list organization and agent-only comments", () => {
  const skill = readApp("skills/collections/SKILL.md");
  assert.match(skill, /category/i);
  assert.match(skill, /objects?.*items?.*related facts/is);
  assert.match(skill, /optional.*headings/is);
  assert.match(skill, /bullets|numbered entries/i);
  assert.match(skill, /nested.*details/i);
  assert.match(skill, /user-(provided|supplied).*outside.*<comment>/is);
  assert.match(skill, /<comment>[\s\S]*<\/comment>/i);
  assert.match(skill, /proactiv/i);
  assert.match(skill, /existing.*duplicate/is);
  assert.match(skill, /one-off|speculative/i);
  assert.match(skill, /## Example[\s\S]*^# /im);
  assert.doesNotMatch(skill, /focused working document for one ongoing effort/i);
});

test("every active surface gives compact category, list, comment, and proactive Collection guidance", () => {
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
    assert.match(guidance, /lists?/i, `${source}: list guidance`);
    assert.match(guidance, /<comment>\.\.\.<\/comment>/i, `${source}: comment convention`);
    assert.match(guidance, /proactiv|don't wait to be asked/i, `${source}: proactive creation`);
    assert.match(guidance, /existing|duplicate/i, `${source}: check-before-create`);
    assert.match(guidance, /one-off|speculative|noise/i, `${source}: creation restraint`);
    assert.doesNotMatch(guidance, /focused working document for one ongoing effort/i, `${source}: obsolete narrow definition`);
  }
});
