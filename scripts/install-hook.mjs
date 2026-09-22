#!/usr/bin/env node
// Register (or remove) the two hooks that get this skill reached, in the user's Claude Code
// settings. `npx skills add` only copies the skill directory, so without this neither reaches a
// fresh machine. Idempotent: re-running is a no-op.
//
// Usage: node scripts/install-hook.mjs [--remove]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const settingsPath = join(homedir(), '.claude', 'settings.json');
const cmd = (f) => `node '${fileURLToPath(new URL(f, import.meta.url))}'`;
// SessionStart puts the skill in context; PreToolUse catches the repo-wide search that the
// context alone never stopped. Matchers differ per event, so each carries its own.
const HOOKS = [
  { event: 'SessionStart', script: 'session-start.mjs', matcher: 'startup|clear|compact' },
  { event: 'PreToolUse', script: 'pretool.mjs', matcher: 'Bash|Grep' },
];
const remove = process.argv.includes('--remove');

if (!existsSync(settingsPath)) {
  console.error(`jev: no settings file at ${settingsPath}`);
  process.exit(1);
}

// A malformed merge would break every future session, so never write without a backup.
const raw = readFileSync(settingsPath, 'utf8');
let settings;
try {
  settings = JSON.parse(raw);
} catch (e) {
  console.error(`jev: ${settingsPath} is not valid JSON (${e.message}); left untouched`);
  process.exit(1);
}

const changed = [];
for (const { event, script, matcher } of HOOKS) {
  const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(script);
  const entries = settings.hooks?.[event] ?? [];
  const present = entries.some((e) => (e.hooks ?? []).some(isOurs));
  if (present === !remove) continue; // already in the requested state

  if (remove) {
    const kept = entries
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((e) => e.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  } else {
    settings.hooks ??= {};
    // Unshift so ours lands before unrelated hooks on the same event.
    settings.hooks[event] = [
      { matcher, hooks: [{ type: 'command', command: cmd(script), timeout: 10 }] },
      ...entries,
    ];
  }
  changed.push(event);
}

if (!changed.length) {
  console.log(`jev: hooks already ${remove ? 'absent' : 'registered'}, nothing to do`);
  process.exit(0);
}

copyFileSync(settingsPath, `${settingsPath}.jev-bak`);
// Two-space indent is what Claude Code writes; matching it keeps the diff to our own lines.
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`jev: ${changed.join(' + ')} ${remove ? 'removed from' : 'registered in'} ${settingsPath}`);
console.log(`jev: previous settings saved to ${settingsPath}.jev-bak`);
if (!remove) console.log('jev: they take effect in the next session — /clear or start a new one');
