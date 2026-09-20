// Self-check for the two pure helpers plus the shipped example config.
// Run: node test/config.test.mjs   (no framework, no network)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exempt, bar, truthFrom, recallAt } from '../scripts/jev.mjs';

const cfg = JSON.parse(readFileSync(new URL('../jev.config.example.json', import.meta.url), 'utf8'));

// exempt: matches on path substring, scoped to the right convention key
assert.equal(exempt(cfg, 'hardcoded_copy', 'src/features/reports/mocks/series.ts'), true);
assert.equal(exempt(cfg, 'hardcoded_copy', 'tests/upload-result.test.ts'), true);
assert.equal(exempt(cfg, 'hardcoded_copy', 'src/features/reports/overview-tab.tsx'), false);
// an exemption must not leak across conventions
assert.equal(exempt(cfg, 'raw_fetch', 'src/features/reports/mocks/series.ts'), false);
assert.equal(exempt(cfg, 'raw_fetch', 'src/services/request.ts'), true);
// unknown key and absent exemptions map both mean "not exempt", never a throw
assert.equal(exempt(cfg, 'no_such_convention', 'anything.ts'), false);
assert.equal(exempt({}, 'hardcoded_copy', 'src/mocks/x.ts'), false);

// bar: threshold boundaries are inclusive at 0.7 and 0.4
assert.equal(bar(0.99), '!');
assert.equal(bar(0.7), '!');
assert.equal(bar(0.69), '?');
assert.equal(bar(0.4), '?');
assert.equal(bar(0.39), ' ');
assert.equal(bar(0), ' ');

// the example config must stay usable as a template: every entry needs all three texts
for (const group of ['conventions', 'gates']) {
  const entries = Object.entries(cfg[group] ?? {});
  assert.ok(entries.length > 0, `${group} must not be empty`);
  for (const [key, v] of entries) {
    const required = group === 'conventions' ? ['ask', 'drift', 'ok'] : ['ask', 'risk', 'ok'];
    for (const f of required) {
      assert.equal(typeof v[f], 'string', `${group}.${key}.${f} must be a string`);
      assert.ok(v[f].length > 10, `${group}.${key}.${f} is too short to steer the model`);
    }
    assert.ok(v.ask.includes('?'), `${group}.${key}.ask must be phrased as a question`);
  }
}

// every exemption key must name a real convention, or it silently does nothing
for (const key of Object.keys(cfg.exemptions ?? {})) {
  assert.ok(cfg.conventions[key], `exemptions.${key} names no convention`);
}

// truthFrom: the leak this guards against is 'A' — a file the commit created did not exist
// when the task was written, so counting it as findable inflates recall.
const rankable = new Set(['src/a.ts', 'src/b.ts', 'src/new.ts']);
assert.deepEqual(
  truthFrom('M\tsrc/a.ts\nA\tsrc/new.ts\nM\tsrc/b.ts', rankable),
  ['src/a.ts', 'src/b.ts']
);
// deleted files are gone from today's tree, so they are unrankable and drop out
assert.deepEqual(truthFrom('D\tsrc/gone.ts\nM\tsrc/a.ts', rankable), ['src/a.ts']);
// files outside the include globs are not candidates, so they cannot count against recall
assert.deepEqual(truthFrom('M\tREADME.md\nM\tsrc/a.ts', rankable), ['src/a.ts']);
// empty and malformed input must yield no truth rather than throwing
assert.deepEqual(truthFrom('', rankable), []);
assert.deepEqual(truthFrom('\n\nM\n', rankable), []);

// recallAt: counts truth files inside the top k, and reports nothing when there is no truth
const ranked = ['src/a.ts', 'src/x.ts', 'src/b.ts', 'src/y.ts'];
assert.equal(recallAt(ranked, ['src/a.ts', 'src/b.ts'], 4), 2);
assert.equal(recallAt(ranked, ['src/a.ts', 'src/b.ts'], 2), 1);   // b.ts sits at rank 3
assert.equal(recallAt(ranked, ['src/a.ts', 'src/b.ts'], 1), 1);
assert.equal(recallAt(ranked, ['src/missing.ts'], 4), 0);          // never ranked at all
assert.equal(recallAt(ranked, [], 4), null);                       // no ground truth to score
assert.equal(recallAt(ranked, ['src/b.ts'], 99), 1);               // k past the end is fine

console.log('ok');
