#!/usr/bin/env node
// PreToolUse hook: the SessionStart preflight is injected before the question is even asked, so
// by the time the grep reflex fires it sits 40 messages back and loses. This lands at the moment
// of the first repo-wide search instead, where the decision is actually being made.
//
// Once per session. A marker file keyed on session_id bounds it to a single prompt, so a long
// grep chain costs one keypress, not ten. Anything unexpected exits 0 — a hook that blocks work
// it cannot classify is worse than no hook.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Empty stdout = no decision, the tool proceeds under the user's normal permission settings.
const pass = () => process.exit(0);

// A search that enumerates files across a tree it has not read — the shape that produces a flood
// and then invites hand-coded exclusions to sort it out. A `grep -rn` for one literal in one file
// is not this.
function broad(tool, input) {
  if (tool === 'Grep') {
    // The Grep tool defaults to files_with_matches; only `content` mode reads what it found.
    return (input.output_mode ?? 'files_with_matches') !== 'content';
  }
  if (tool !== 'Bash') return false;
  const cmd = String(input.command ?? '');
  if (!/\bgrep\b/.test(cmd)) return false;
  const recursive = /\s-[a-zA-Z]*[rR]/.test(cmd);
  // -l/-c/-o, and their long forms, list or count matches instead of showing them. Deliberately
  // NOT --include: scoping a targeted `grep -rn` to one file type is the normal shape, and asking
  // about it teaches the user to stop reading the reason.
  const enumerating =
    /\s-[a-zA-Z]*[lco]/.test(cmd) ||
    /--(count|files-with(out)?-match(es)?|only-matching)\b/.test(cmd);
  return recursive && enumerating;
}

const REASON = `jev-assist is installed and this is the search it exists for: a repo-wide sweep of \
files you have not read. If what comes back is a flood you then narrow with exclusions that need \
to know what a file *is* (copy or comment, fixture or real, deliberate \`catch {}\`), that is a \
per-file judgment — \`jev drift\` makes it in one call per file, and \`jev rerank\` orders a pool \
against a task. Invoke the skill and read its routing table before writing the next pattern. \
Approve to run this search anyway; you will not be asked again this session.`;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    pass();
  }
  if (!ev || !broad(ev.tool_name, ev.tool_input ?? {})) pass();

  const marker = join(tmpdir(), `jev-asked-${String(ev.session_id ?? 'nosession').replace(/[^\w-]/g, '')}`);
  if (existsSync(marker)) pass();
  // An unwritable tmp means asking every time, which is noisy but still better than never.
  try {
    writeFileSync(marker, '');
  } catch {}

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: REASON,
      },
    }) + '\n'
  );
});
