// Shared arg parser for the small STATE_DIR CLIs (calendar-cli, checklist-cli). Splits
// `--key value`, `--key=value`, and bare `--flag` from positionals. A VALUELESS flag must be
// named in `boolFlags` so a following positional isn't swallowed as its value (so
// `show --open <name>` works, not just `show <name> --open`); any other `--key` greedily
// takes the next non-`--` token as its value. `--key=` is the escape hatch for a value that
// itself starts with `-`. (discord-cli has its own parser with stricter, different semantics.)
export function parseFlags(
  rest: string[],
  boolFlags: ReadonlySet<string> = new Set(),
): { flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) { flags[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
      const key = tok.slice(2);
      if (boolFlags.has(key)) flags[key] = true;
      else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) flags[key] = rest[++i];
      else flags[key] = true;
    } else positionals.push(tok);
  }
  return { flags, positionals };
}
