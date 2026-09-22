#!/usr/bin/env node
// Register (or remove) the SessionStart hook in the user's Claude Code settings.
// `npx skills add` only copies the skill directory, so without this the preflight never
// reaches a fresh machine. Idempotent: re-running is a no-op.
//
// Usage: node scripts/install-hook.mjs [--remove]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookScript = fileURLToPath(new URL('session-start.mjs', import.meta.url));
const command = `node '${hookScript}'`;
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

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('session-start.mjs');
const entries = settings.hooks?.SessionStart ?? [];
const present = entries.some((e) => (e.hooks ?? []).some(isOurs));

if (remove) {
  if (!present) {
    console.log('jev: hook not registered, nothing to remove');
    process.exit(0);
  }
  const kept = entries
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((e) => e.hooks.length > 0);
  if (kept.length) settings.hooks.SessionStart = kept;
  else delete settings.hooks.SessionStart;
} else {
  if (present) {
    console.log('jev: hook already registered');
    process.exit(0);
  }
  settings.hooks ??= {};
  // Unshift so the preflight lands before unrelated SessionStart hooks.
  settings.hooks.SessionStart = [
    { matcher: 'startup|clear|compact', hooks: [{ type: 'command', command, timeout: 10 }] },
    ...entries,
  ];
}

copyFileSync(settingsPath, `${settingsPath}.jev-bak`);
// Two-space indent is what Claude Code writes; matching it keeps the diff to our own lines.
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`jev: hook ${remove ? 'removed from' : 'registered in'} ${settingsPath}`);
console.log(`jev: previous settings saved to ${settingsPath}.jev-bak`);
if (!remove) console.log('jev: it takes effect in the next session — /clear or start a new one');
