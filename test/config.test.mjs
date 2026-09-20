// Self-check for the two pure helpers plus the shipped example config.
// Run: node test/config.test.mjs   (no framework, no network)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exempt, bar } from '../scripts/jev.mjs';

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

console.log('ok');
