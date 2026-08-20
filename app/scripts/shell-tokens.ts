// shell-tokens: a conservative, quote-aware lexer for Claude-harness Bash
// command strings, built for run-observer's classification (spec §4). It
// answers exactly ONE question: is this command a single simple command
// (optionally ending in a heredoc), or two simple commands joined by exactly
// one '|', with per-token quoting metadata and the heredoc body exposed? It
// is deliberately NOT a POSIX shell -- no word splitting, globbing, or
// expansion semantics -- and every other shape fails ({ok:false}) AT LEX
// TIME, so the classifier never inspects argv tails for constructs the lexer
// already rejected (redirects die here, not in classification).
//
// Substitution scoping follows the operator-approved reading of 2026-08-20
// (spec §4): '$(' and backticks are banned ONLY where the shell would execute
// them -- unquoted text, double-quoted strings, and UNQUOTED-delimiter
// heredoc bodies. Single-quoted strings and <<'EOF' (or <<"EOF") bodies are
// opaque literal text, never re-inspected: the shipped prompts teach heredoc
// reply shapes (prompt.md, sms-prompt.md, discord-prompt.md, and the
// collections/recipes save forms) whose bodies are arbitrary prose where
// markdown backticks are routine, so a literal-anywhere reading would
// disqualify most real reply bodies.
//
// Lex-time rejections (the classifier then fails open): ';', '&&', '||', a
// newline followed by any non-whitespace command text, background '&' in any
// form, every redirect ('>', '<', '>>', '2>' -- the ONLY legal '<' is the
// heredoc '<<'), unquoted parens (subshell/process substitution), a '#'
// starting a comment token, a dangling or second '|', and unterminated
// quoting or heredocs.

export interface ShellWord {
  text: string;
  quoted: boolean;
}

export interface ShellHeredoc {
  body: string;
  quotedDelim: boolean;
}

export interface ShellSegment {
  argv: ShellWord[];
  heredoc?: ShellHeredoc;
}

export type TokenizedCommand = { ok: true; segments: ShellSegment[] } | { ok: false };

// A double-quoted string and an unquoted-delimiter heredoc body are the two
// quoting contexts (besides unquoted text) where the shell EXECUTES a command
// substitution. A bare $VAR is variable expansion, not substitution -- it
// executes nothing -- so only these two triggers are banned.
function hasSubstitution(s: string): boolean {
  return s.includes("$(") || s.includes("`");
}

// Heredoc body: the lines from `start` up to (excluding) the terminator line
// (the line equal to `delim`), joined with "\n" and with no trailing newline.
// Returns null when the input ends first (an unterminated heredoc). `<<-`
// strips leading tabs from every line, for both the terminator comparison
// and the preserved body, matching shell semantics. A trailing "\r" is
// dropped per line so CRLF command text still finds its terminator.
function scanHeredocBody(cmd: string, start: number, delim: string, tabStripped: boolean): { body: string; after: number } | null {
  const lines: string[] = [];
  let pos = start;
  for (;;) {
    const nl = cmd.indexOf("\n", pos);
    let line = nl === -1 ? cmd.slice(pos) : cmd.slice(pos, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (tabStripped) line = line.replace(/^\t+/, "");
    if (line === delim) return { body: lines.join("\n"), after: nl === -1 ? cmd.length : nl + 1 };
    if (nl === -1) return null;
    lines.push(line);
    pos = nl + 1;
  }
}

// Characters that end an unquoted heredoc delimiter word: whitespace,
// newlines, quotes (a mid-delimiter quote means the word ended early -- the
// post-delimiter scan below then rejects the leftover), and the operators.
function endsDelimiter(c: string): boolean {
  return " \t\r\n'\";&|><()".includes(c);
}

export function tokenizeCommand(cmd: string): TokenizedCommand {
  const n = cmd.length;
  const segments: ShellSegment[] = [];
  let argv: ShellWord[] = [];
  let word: string | null = null; // the unquoted word being accumulated
  let pipeOpen = false;           // exactly one '|' may join two simple commands

  const finishWord = (): void => {
    if (word !== null) {
      argv.push({ text: word, quoted: false });
      word = null;
    }
  };

  let i = 0;
  while (i < n) {
    const c = cmd[i];

    // Whitespace separates words.
    if (c === " " || c === "\t" || c === "\r") {
      finishWord();
      i++;
      continue;
    }

    // A newline outside a heredoc body is a command separator: only a
    // whitespace-only remainder may follow (the '<<' branch consumes a
    // heredoc's newline and body itself).
    if (c === "\n") {
      finishWord();
      if (cmd.slice(i + 1).trim() !== "") return { ok: false };
      break;
    }

    // Single-quoted string: fully opaque, contents never re-inspected.
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return { ok: false }; // unterminated quote
      finishWord();
      argv.push({ text: cmd.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }

    // Double-quoted string: command substitution EXECUTES inside double
    // quotes, so '$('/backtick contents are a rejection, not a word.
    if (c === '"') {
      const end = cmd.indexOf('"', i + 1);
      if (end === -1) return { ok: false };
      const text = cmd.slice(i + 1, end);
      if (hasSubstitution(text)) return { ok: false };
      finishWord();
      argv.push({ text, quoted: true });
      i = end + 1;
      continue;
    }

    // A '#' starting a comment token (a mid-word '#' is an ordinary
    // character: it can only reach this loop at a word boundary, because the
    // word scanner below never breaks on '#').
    if (c === "#") return { ok: false };

    // Exactly one '|' joining two non-empty simple commands.
    if (c === "|") {
      finishWord();
      if (pipeOpen || argv.length === 0) return { ok: false }; // second pipe / empty left side
      segments.push({ argv });
      argv = [];
      pipeOpen = true;
      i++;
      continue;
    }

    // Separators, background, subshells, redirects -- all lex-time
    // rejections ('&&' dies at '&', '||' at the second '|', '2>' at '>').
    if (c === ";" || c === "&" || c === ">" || c === "(" || c === ")") return { ok: false };

    // '<' is legal ONLY as the heredoc operator '<<' (optionally '<<-'), and
    // a heredoc ENDS its segment: after the delimiter word only whitespace up
    // to the newline that starts the body, and after the terminator line only
    // whitespace to the end of the command.
    if (c === "<") {
      if (cmd[i + 1] !== "<") return { ok: false }; // redirect '<' / process substitution '<('
      i += 2;
      const tabStripped = cmd[i] === "-";
      if (tabStripped) i++;
      finishWord();
      if (argv.length === 0) return { ok: false }; // a heredoc ends a simple command
      while (cmd[i] === " " || cmd[i] === "\t") i++;
      let delim: string;
      let quotedDelim = false;
      if (cmd[i] === "'" || cmd[i] === '"') {
        // Quoted delimiter: the body is opaque. A double-quoted delimiter
        // obeys the same double-quote substitution rule.
        const q = cmd[i];
        const end = cmd.indexOf(q, i + 1);
        if (end === -1) return { ok: false };
        delim = cmd.slice(i + 1, end);
        if (q === '"' && hasSubstitution(delim)) return { ok: false };
        quotedDelim = true;
        i = end + 1;
      } else {
        const start = i;
        while (i < n && !endsDelimiter(cmd[i])) i++;
        delim = cmd.slice(start, i);
        if (delim === "") return { ok: false }; // '<<<' here-string / bare '<<' / '<<;'
      }
      while (cmd[i] === " " || cmd[i] === "\t" || cmd[i] === "\r") i++;
      if (cmd[i] !== "\n") return { ok: false }; // no newline: unterminated, or content after the delimiter
      const scanned = scanHeredocBody(cmd, i + 1, delim, tabStripped);
      if (scanned === null) return { ok: false }; // unterminated heredoc
      // An unquoted-delimiter body undergoes expansion in a real shell, so a
      // substitution there is in an executing position.
      if (!quotedDelim && hasSubstitution(scanned.body)) return { ok: false };
      segments.push({ argv, heredoc: { body: scanned.body, quotedDelim } });
      if (cmd.slice(scanned.after).trim() !== "") return { ok: false }; // the heredoc ends the command
      return { ok: true, segments };
    }

    // Unquoted word: accumulate ordinary characters until a boundary.
    // Unquoted text is an executing position, so '$(' and backticks die
    // here. A backslash has no escape meaning -- kept literal, since the
    // taught shapes never rely on shell escaping.
    const start = i;
    while (i < n) {
      const ch = cmd[i];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "'" || ch === '"' || ch === "<") break;
      if (ch === ";" || ch === "&" || ch === "|" || ch === ">" || ch === "(" || ch === ")") return { ok: false };
      if ((ch === "$" && cmd[i + 1] === "(") || ch === "`") return { ok: false };
      i++;
    }
    word = cmd.slice(start, i);
  }

  finishWord();
  if (argv.length > 0) segments.push({ argv });
  // One simple command, or two joined by one pipe -- and a dangling pipe
  // (nothing after it) is not a pipeline.
  if (segments.length === 0 || (pipeOpen && argv.length === 0)) return { ok: false };
  return { ok: true, segments };
}
