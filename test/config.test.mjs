// Self-check for the two pure helpers plus the shipped example config.
// Run: node test/config.test.mjs   (no framework, no network)
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync as copySync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// CLI dispatch: the guard compares import.meta.url to argv[1], and a naive `file://` concat made
// every command a silent exit-0 no-op from a path with a space (skill dirs) or a symlink (npm
// link's bin shim). Needs a subprocess; `bogus` hits the usage line before any config or network.
{
  const dir = mkdtempSync(join(tmpdir(), 'jev sp ')); // space in the name is the regression
  const copy = join(dir, 'jev.mjs');
  copySync(new URL('../scripts/jev.mjs', import.meta.url), copy);
  const run = () => {
    try {
      execFileSync(process.execPath, [copy, 'bogus'], { encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, err: '' };
    } catch (e) {
      return { code: e.status, err: e.stderr };
    }
  };
  const r = run();
  assert.equal(r.code, 1, 'CLI must dispatch from a spaced/symlinked path, not exit 0 silently');
  assert.match(r.err, /usage: jev/);
  rmSync(dir, { recursive: true, force: true });
}

// CLI git failures must die with the clean `jev:` line, not a raw Node unhandled-rejection
// stack — outside a repo every command crashes at the first `git ls-files`, and `validate`
// crashes on a zero-commit repo (`git log` fatal). Three install-time agents hit this in a
// row. Needs a subprocess; each path reaches git() before anything else can fail first.
{
  const root = mkdtempSync(join(tmpdir(), 'jev-gitfail '));
  const copy = join(root, 'jev.mjs');
  copySync(new URL('../scripts/jev.mjs', import.meta.url), copy);
  const config = JSON.stringify({
    description: 'temporary config for a crash-path regression test',
    include: ['**/*'],
  });
  const nogit = join(root, 'nogit');
  mkdirSync(nogit);
  writeFileSync(join(nogit, 'jev.config.json'), config);
  const empty = join(root, 'empty-repo');
  mkdirSync(empty);
  writeFileSync(join(empty, 'jev.config.json'), config);
  execFileSync('git', ['init', '-q'], { cwd: empty }); // zero commits on purpose

  const run = (args, cwd) => {
    try {
      // XDG pointed inside the tree keeps the machine's stored key out of the run entirely
      execFileSync(process.execPath, [copy, ...args], {
        encoding: 'utf8', cwd, stdio: 'pipe',
        env: { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg') },
      });
      return { code: 0, err: '' };
    } catch (e) {
      return { code: e.status, err: e.stderr };
    }
  };
  const clean = (r, label) => {
    assert.equal(r.code, 1, `${label}: must exit 1`);
    assert.match(r.err, /^jev: git .*failed: fatal: /m, `${label}: must die with the clean jev: line`);
    assert.doesNotMatch(r.err, /^\s+at /m, `${label}: must not dump a stack`);
    assert.doesNotMatch(r.err, /Node\.js v\d/, `${label}: must not crash as an unhandled rejection`);
  };
  clean(run(['check'], nogit), 'check outside a git repo');
  clean(run(['validate'], empty), 'validate on a zero-commit repo');
  rmSync(root, { recursive: true, force: true });
}

// SKILL.md frontmatter: the description is the only thing an agent reads before the skill fires,
// so a silent truncation there means the skill never triggers at all. Keep it under 1024 and keep
// each command's trigger in it — a description covering only `rerank` is how drift went unused.
{
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const description = skill.match(/^description:[^\n]*/m)?.[0];
  assert.ok(description, 'SKILL.md must carry a description in its frontmatter');
  assert.ok(description.length < 1024, `description is ${description.length} chars, too close to the 1024 cap`);
  for (const cmd of ['rerank', 'drift', 'gate', 'validate'])
    assert.match(description, new RegExp(`\`${cmd}\``), `description must say when to reach for ${cmd}`);
}

console.log('ok');
