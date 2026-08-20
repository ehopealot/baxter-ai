// Tests for shell-tokens: the conservative quote-aware Bash-command lexer
// behind run-observer's Claude-harness classification (spec §4, whose
// substitution rule is scoped per the operator-approved reading of
// 2026-08-20). Both directions of conservatism are pinned:
//   OPACITY -- single-quoted strings and <<'EOF' quoted-delimiter heredoc
//   bodies are inert literal text (';', '|', '$(', '#', backticks inside are
//   never operators), because the shipped prompts teach heredoc reply shapes
//   (prompt.md / sms-prompt.md / discord-prompt.md replies, collections-cli
//   and recipes-cli saves) whose bodies are arbitrary prose where markdown
//   backticks are routine -- a literal-anywhere reading would disqualify most
//   real reply bodies.
//   REJECTION -- '$(' / backticks die wherever the shell would EXECUTE them
//   (unquoted text, double-quoted strings, unquoted-delimiter heredoc
//   bodies), and separators (';', '&&', '||', a newline starting another
//   command), background '&', redirects ('>', '<', '>>' -- the ONLY legal
//   '<' is the heredoc '<<'), subshell parens, '#' comments, a dangling or
//   second '|', and unterminated quoting or heredocs all fail AT LEX TIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeCommand } from "./shell-tokens.ts";

// Assert a lex succeeds and hand back its segments for the assertions.
function lexes(cmd: string) {
  const r = tokenizeCommand(cmd);
  if (!r.ok) assert.fail(`expected ${JSON.stringify(cmd)} to lex, got ${JSON.stringify(r)}`);
  return r.segments;
}

// A rejection is EXACTLY {ok:false}: no partial tokenization ever escapes.
function rejected(cmd: string) {
  assert.deepEqual(tokenizeCommand(cmd), { ok: false }, `expected ${JSON.stringify(cmd)} to be rejected`);
}

// ---- clean accepted shapes ----

test("a single simple command lexes with per-token quoting metadata", () => {
  const segs = lexes("calendar-cli list");
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { argv: [{ text: "calendar-cli", quoted: false }, { text: "list", quoted: false }] });
});

test("quoted arguments are single word tokens marked quoted (both quote kinds)", () => {
  const single = lexes("sms-cli send '+1 555 000 1111'");
  assert.deepEqual(single[0].argv[2], { text: "+1 555 000 1111", quoted: true });
  const double = lexes('sms-cli send-group "gid 123"');
  assert.deepEqual(double[0].argv[2], { text: "gid 123", quoted: true });
});

test("a printf|cmd pipeline lexes as exactly two segments with quoting preserved", () => {
  const segs = lexes("printf 'See https://home.bax.bot/calendar.' | sms-cli send +15551234567");
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { argv: [{ text: "printf", quoted: false }, { text: "See https://home.bax.bot/calendar.", quoted: true }] });
  assert.deepEqual(segs[1], { argv: [{ text: "sms-cli", quoted: false }, { text: "send", quoted: false }, { text: "+15551234567", quoted: false }] });
});

test("a pipe without surrounding whitespace still separates the two commands", () => {
  const segs = lexes("printf 'hi'|sms-cli send 1");
  assert.deepEqual(segs.map((s) => s.argv.map((w) => w.text)), [["printf", "hi"], ["sms-cli", "send", "1"]]);
});

test("a heredoc-tailed command exposes the body and quotedDelim", () => {
  const segs = lexes("mail-cli reply abc-123 <<'EOF'\nHello!\nEOF");
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].argv.map((w) => w.text), ["mail-cli", "reply", "abc-123"]);
  assert.deepEqual(segs[0].heredoc, { body: "Hello!", quotedDelim: true });
});

test("a pipeline whose right side ends in a heredoc lexes (the taught delivery variants)", () => {
  const segs = lexes("printf 'x' | sms-cli send +15551234567 <<'EOF'\nbody\nEOF");
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[1].heredoc, { body: "body", quotedDelim: true });
});

test("a trailing whitespace-only remainder (incl. newlines) is fine; an empty command is not", () => {
  lexes("calendar-cli list\n");
  lexes("calendar-cli list  \n\t ");
  rejected("");
  rejected("   ");
});

// ---- single-quote opacity (operator-approved scoping) ----

test("single-quoted strings are fully opaque: shell metacharacters inside are inert", () => {
  for (const arg of ["';'", "'|'", "'$('", "'#'", "'&&'", "'>'", "'&'", "'`cmd`'", "'\"'"]) {
    const segs = lexes(`calendar-cli find ${arg}`);
    assert.deepEqual(segs[0].argv[2], { text: arg.slice(1, -1), quoted: true }, `inert inside ${arg}`);
  }
});

test("a 'single-quoted `cmd`' argument is a normal quoted word", () => {
  const segs = lexes("echo 'single-quoted `cmd`'");
  assert.deepEqual(segs[0].argv, [{ text: "echo", quoted: false }, { text: "single-quoted `cmd`", quoted: true }]);
});

test("an unquoted $( ... ) or backtick in an EXECUTING position is rejected", () => {
  rejected("calendar-cli list $(whoami)");
  rejected("calendar-cli list `whoami`");
  rejected("echo $(cmd) extra");
});

// ---- double-quoted strings ----

test("double-quoted strings containing '$(' or a backtick fail (substitution executes there)", () => {
  rejected('calendar-cli list "$(cmd)"');
  rejected('calendar-cli list "run `x` now"');
});

test("double-quoted strings without substitutions are normal quoted words", () => {
  const segs = lexes('checklist-cli find "what they said; honestly"');
  assert.deepEqual(segs[0].argv[2], { text: "what they said; honestly", quoted: true });
});

test("the other quote kind nests literally inside a quoted string", () => {
  const segs = lexes(`echo 'say "hi"' "don't panic"`);
  assert.deepEqual(segs[0].argv[1], { text: 'say "hi"', quoted: true });
  assert.deepEqual(segs[0].argv[2], { text: "don't panic", quoted: true });
});

// ---- heredocs ----

test("a <<'EOF' body is fully opaque: the collections-cli save shape with ';', '$(' and markdown backticks", () => {
  const cmd = [
    "collections-cli save weeknight-pasta --expect 3 <<'EOF'",
    "# Weeknight Pasta",
    "",
    "Prose; with $(fake) and `backticks`.",
    "See `calendar-cli` output at https://home.bax.bot/calendar.",
    "EOF",
  ].join("\n");
  const segs = lexes(cmd);
  assert.deepEqual(segs[0].argv.map((w) => w.text), ["collections-cli", "save", "weeknight-pasta", "--expect", "3"]);
  assert.deepEqual(segs[0].heredoc, {
    body: "# Weeknight Pasta\n\nProse; with $(fake) and `backticks`.\nSee `calendar-cli` output at https://home.bax.bot/calendar.",
    quotedDelim: true,
  });
});

test("the same body under an UNQUOTED delimiter fails on '$(' or a backtick, and lexes under <<'EOF'", () => {
  const body = "line with $(x) inside";
  rejected(`collections-cli save x <<EOF\n${body}\nEOF`);
  lexes(`collections-cli save x <<'EOF'\n${body}\nEOF`);
  rejected("collections-cli save x <<EOF\nline with `x` inside\nEOF");
  lexes("collections-cli save x <<'EOF'\nline with `x` inside\nEOF");
});

test("an unquoted-delimiter heredoc with a clean body lexes ok with quotedDelim false", () => {
  const segs = lexes("collections-cli save x <<EOF\nplain body\nEOF");
  assert.deepEqual(segs[0].heredoc, { body: "plain body", quotedDelim: false });
});

test('a <<"EOF" delimiter is also a quoted (opaque) delimiter', () => {
  const segs = lexes('collections-cli save x <<"EOF"\n$(x) `y`\nEOF');
  assert.deepEqual(segs[0].heredoc, { body: "$(x) `y`", quotedDelim: true });
});

test("multi-line bodies are preserved verbatim, including blank and indented lines", () => {
  const segs = lexes("mail-cli reply t-1 <<'EOF'\nfirst\n\n  third (indented)\nEOF");
  assert.deepEqual(segs[0].heredoc, { body: "first\n\n  third (indented)", quotedDelim: true });
});

test("an empty heredoc body (terminator immediately follows the newline) is ''", () => {
  const segs = lexes("mail-cli reply t-1 <<'EOF'\nEOF");
  assert.deepEqual(segs[0].heredoc, { body: "", quotedDelim: true });
});

test("whitespace between '<<' and the delimiter is allowed, as in shell", () => {
  const segs = lexes("mail-cli reply t-1 << 'EOF'\nx\nEOF");
  assert.deepEqual(segs[0].heredoc, { body: "x", quotedDelim: true });
});

test("<<- strips leading tabs from body lines and the terminator", () => {
  const segs = lexes("mail-cli reply t-1 <<-EOF\n\tbody\n\tEOF");
  assert.deepEqual(segs[0].heredoc, { body: "body", quotedDelim: false });
});

test("CRLF line endings lex: the per-line trailing \\r is stripped, and a CRLF body that never hits its terminator is still unterminated", () => {
  const segs = lexes("mail-cli reply t-1 <<'EOF'\r\nHello!\r\nEOF\r\n");
  assert.deepEqual(segs[0].heredoc, { body: "Hello!", quotedDelim: true });
  assert.ok(!segs[0].heredoc!.body.includes("\r"), "no \\r survives into the body");
  rejected("mail-cli reply t-1 <<'EOF'\r\nHello!\r\nEOFX\r\n");
});

test("unterminated heredocs fail (no terminator, no newline, no delimiter, here-string)", () => {
  rejected("mail-cli reply t-1 <<'EOF'\nbody"); // no terminator line
  rejected("mail-cli reply t-1 <<'EOF'");       // no newline at all
  rejected("mail-cli reply t-1 <<");            // no delimiter
  rejected("mail-cli reply t-1 <<< 'x'");       // <<< here-string is not the heredoc shape
});

test("the heredoc ENDS the command: only whitespace may follow the terminator", () => {
  rejected("cmd <<'EOF'\nx\nEOF | next");
  rejected("cmd <<'EOF'\nx\nEOF; next");
  rejected("cmd <<'EOF'\nx\nEOF\nnext");
  lexes("cmd <<'EOF'\nx\nEOF\n");
});

test("non-whitespace between the heredoc delimiter and its newline fails", () => {
  rejected("cmd <<'EOF' extra\nx\nEOF");
});

test("a heredoc must end a non-empty simple command", () => {
  rejected("<<'EOF'\nx\nEOF");
});

// ---- lex-time rejections: separators, background, redirects, subshells, comments ----

test("command separators die at lex time: ';', '&&', '||'", () => {
  rejected("calendar-cli list;next");
  rejected("calendar-cli list ; next");
  rejected("calendar-cli list && next");
  rejected("calendar-cli list || next");
});

test("background '&' dies at lex time in any form", () => {
  rejected("calendar-cli list &");
  rejected("calendar-cli list&");
});

test("redirect operators die at lex time (the ONLY legal '<' is the heredoc '<<')", () => {
  rejected("calendar-cli list > out");
  rejected("calendar-cli list >out");
  rejected("calendar-cli list >> app");
  rejected("calendar-cli list < in");
  rejected("calendar-cli 2> err");
});

test("process substitution and subshell parens die at lex time", () => {
  rejected("cat <(make)");
  rejected("cat >(upload)");
  rejected("(calendar-cli list)");
  rejected("calendar-cli list)");
});

test("a '#' starting a comment token dies at lex time; a mid-word '#' is literal", () => {
  rejected("calendar-cli list # a comment");
  rejected("# just a comment");
  const segs = lexes("echo a#b");
  assert.deepEqual(segs[0].argv[1], { text: "a#b", quoted: false });
});

test("a newline starting another command fails ('calendar-cli list' newline 'next-command')", () => {
  rejected("calendar-cli list\nnext-command");
  rejected("calendar-cli list ;\nnext");
});

test("pipes: exactly one, joining two non-empty simple commands", () => {
  rejected("printf x | sms-cli send 1 | tee"); // a second '|'
  rejected("printf x |");                       // dangling pipe
  rejected("| sms-cli send 1");                  // empty left side
});

test("unterminated quoting fails", () => {
  rejected("echo 'unterminated");
  rejected('echo "unterminated');
});

// ---- word-level contract details (classification-grade, deliberately not POSIX) ----

test("a quote directly after word characters starts a NEW token (no shell concatenation)", () => {
  const segs = lexes("echo abc'def ghi'");
  assert.deepEqual(segs[0].argv, [
    { text: "echo", quoted: false },
    { text: "abc", quoted: false },
    { text: "def ghi", quoted: true },
  ]);
});

test("variable-looking text ($VAR, ${VAR}) is inert literal text, not a substitution", () => {
  const segs = lexes("echo $HOME");
  assert.deepEqual(segs[0].argv[1], { text: "$HOME", quoted: false });
  lexes("echo ${HOME}");
  lexes('echo "$HOME"');
});
