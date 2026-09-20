// Self-check for the two pure helpers plus the shipped example config.
// Run: node test/config.test.mjs   (no framework, no network)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exempt, bar, truthFrom, recallAt, configProblems, provider, keyPath, pathspec } from '../scripts/jev.mjs';

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

// configProblems is what `jev check` reports and what gates an agent-generated config.
// The shipped example is a template, so its one expected problem is the unreplaced description.
assert.deepEqual(configProblems(cfg), ['description: still the template placeholder']);

const good = { ...cfg, description: 'A React admin dashboard built with TanStack Query and i18next.' };
assert.deepEqual(configProblems(good), []);

// each rule fires on its own, and on a config that is missing everything nothing throws
assert.ok(configProblems({ ...good, include: [] }).some((p) => p.startsWith('include:')));
assert.ok(configProblems({ ...good, description: 'too short' }).some((p) => p.startsWith('description:')));
assert.ok(configProblems({ ...good, gates: {} }).some((p) => p.startsWith('gates:')));
assert.ok(
  configProblems({ ...good, exemptions: { no_such_convention: ['/x/'] } })
    .some((p) => p.startsWith('exemptions.no_such_convention:'))
);
assert.ok(
  configProblems({ ...good, conventions: { c: { ask: 'no question mark here at all', drift: 'x'.repeat(11), ok: 'y'.repeat(11) } } })
    .some((p) => p === 'conventions.c.ask: must be phrased as a question')
);
// a gate needs `risk`, not `drift` — the wrong key must be caught, not silently accepted
assert.ok(
  configProblems({ ...good, gates: { g: { ask: 'Does this touch auth?', drift: 'x'.repeat(11), ok: 'y'.repeat(11) } } })
    .some((p) => p === 'gates.g.risk: missing, or too short to steer the model')
);
assert.ok(configProblems({}).length > 0);

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

// provider: routing is by key prefix, because OpenRouter proxies to the same body shape.
assert.equal(provider('sk-or-v1-abc123').name, 'openrouter');
assert.equal(provider('sk-or-v1-abc123').url, 'https://openrouter.ai/api/alpha/decisions');
assert.equal(provider('sk-or-v1-abc123').model, '~typesafe/jev-latest');
assert.equal(provider('ts-live-abc123').name, 'typesafe');
assert.equal(provider('ts-live-abc123').url, 'https://api.typesafe.ai/v1/systemone');
assert.equal(provider('ts-live-abc123').model, 'jev-latest');
// an explicit override wins over the prefix, so a self-hosted gateway needs no code change
const custom = provider('sk-or-v1-abc', { JEV_API_URL: 'https://gw.internal/v1/systemone', JEV_MODEL: 'jev-pinned' });
assert.equal(custom.name, 'custom');
assert.equal(custom.url, 'https://gw.internal/v1/systemone');
assert.equal(custom.model, 'jev-pinned');
// overriding only the model must keep the prefix-derived URL — this is how a version gets pinned
assert.equal(provider('sk-or-v1-abc', { JEV_MODEL: 'typesafe/jev-1.13' }).url, 'https://openrouter.ai/api/alpha/decisions');
assert.equal(provider('sk-or-v1-abc', { JEV_MODEL: 'typesafe/jev-1.13' }).model, 'typesafe/jev-1.13');

// pathspec: `git ls-files src/**/*.ts` skips src/main.ts, because pathspecs are not globs by
// default — ** wants an intervening directory. The :(glob) prefix is what makes them behave.
assert.equal(pathspec('src/**/*.ts'), ':(glob)src/**/*.ts');
assert.equal(pathspec('**/*.tsx'), ':(glob)**/*.tsx');
// magic the caller already supplied must survive untouched, not get double-prefixed
assert.equal(pathspec(':(glob)src/**/*.ts'), ':(glob)src/**/*.ts');
assert.equal(pathspec(':!src/generated/'), ':!src/generated/');

// keyPath: outside the repo, and honouring XDG when set — a key in the tree gets committed
assert.equal(keyPath({ XDG_CONFIG_HOME: '/tmp/xdg' }), '/tmp/xdg/jev/key');
assert.ok(keyPath({}).endsWith('/.config/jev/key'));

console.log('ok');
