#!/usr/bin/env node
// SessionStart hook: inject the jev-assist preflight so the skill is considered before
// the first grep, not after. JSON.stringify does the escaping bash would need
// five passes for.
import { readFileSync } from 'node:fs';

const preflight = readFileSync(new URL('../hooks/preflight.md', import.meta.url), 'utf8');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: preflight,
  },
}) + '\n');
