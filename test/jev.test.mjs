// Offline checks for jev.mjs: batching, the cut, flag/spec parsing, answer
// readers, cache keys — plus the CLI's run-path contracts against a local mock
// endpoint. `die` normally exits, so in this process it is turned into a throw
// carrying its message; the CLI itself runs as subprocesses via spawnSync.
// No external network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  batchByTokens,
  cut,
  parseOpt,
  parseOpts,
  parseLevels,
  Argv,
  readNoul,
  readChoice,
  readScore,
  cacheKey,
  pathPrefix,
  groupByPath,
} from '../scripts/jev.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'jev.mjs');
const cli = (args, input) => spawnSync(process.execPath, [script, ...args], { input: input ?? '', encoding: 'utf8' });

// die prints to stderr then process.exit(1); reroute both so in-process die
// paths are assertable. Subprocesses are unaffected.
let lastErr = '';
console.error = (m) => (lastErr = m);
process.exit = (code) => {
  throw Object.assign(new Error(lastErr), { code });
};

test('batchByTokens stays under budget and counts every line', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(80)}`);
  const batches = batchByTokens(lines, 5000);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().length, lines.length); // nothing dropped
  for (const b of batches.slice(0, -1))
    assert.ok(b.reduce((n, l) => n + 70 + l.length / 2, 0) <= 5000);
});

test('batchByTokens ships an oversized single line alone', () => {
  const big = 'y'.repeat(99_000);
  const batches = batchByTokens([big, 'small', 'small2'], 1000);
  assert.deepEqual(batches[0], [big]);
  assert.equal(batches.flat().length, 3);
});

test('cut finds the widest gap', () => {
  const ps = [0.99, 0.98, 0.97, 0.95, 0.93, 0.92, 0.91, 0.31, 0.3, 0.29, 0.28, 0.27];
  const c = cut(ps, null);
  assert.equal(c.at, 7);
  assert.match(c.why, /cliff 0\.91→0\.31/);
});

test('cut falls back to the threshold, then to top 10', () => {
  const c1 = cut([0.9, 0.85, 0.8, 0.75], null); // small pool, no cliff
  assert.equal(c1.at, 4);
  assert.match(c1.why, /0\.70/);
  const c2 = cut([0.5, 0.4, 0.3], null);
  assert.equal(c2.at, 3);
  assert.match(c2.why, /top 10/);
});

test('cut honors --top', () => {
  assert.deepEqual([cut([0.9, 0.1], 1).at, cut([0.9, 0.1], 1).why], [1, '--top 1']);
});

test('parseOpt splits on the first colon only', () => {
  assert.deepEqual(parseOpt('api:HTTP handler or route:thing', '--opt'), ['api', 'HTTP handler or route:thing']);
  assert.throws(() => parseOpt('no-colon', '--opt'), /needs name:criteria/);
});

test('parseOpts requires two distinct, described options', () => {
  assert.deepEqual(parseOpts(['api:x', 'db:y:z'], 'choice', '--opt'), [['api', 'x'], ['db', 'y:z']]);
  assert.throws(() => parseOpts(['api:x'], 'choice', '--opt'), /at least two options/);
  assert.throws(() => parseOpts(['api:x', 'api:y'], 'choice', '--opt'), /twice/);
  assert.throws(() => parseOpts(['api:', 'db:y'], 'choice', '--opt'), /non-empty/);
});

test('parseLevels orders numerically and rejects junk', () => {
  assert.deepEqual(parseLevels(['2:worst', '0:fine', '1:mid']), [[0, 'fine'], [1, 'mid'], [2, 'worst']]);
  assert.throws(() => parseLevels(['x:oops']), /non-negative integer/);
  assert.throws(() => parseLevels(['1:a', '1:b']), /twice/);
  assert.throws(() => parseLevels([]), /at least one level/);
});

test('Argv accepts both = and space flag forms, anywhere', () => {
  const a = new Argv(['the question', '--top', '7', '--opt', 'api:x', '--json', '--opt=db:y', '--level=0:lo', '--fresh']);
  assert.equal(a.pos[0], 'the question');
  assert.equal(a.top, 7);
  assert.deepEqual(a.opts, ['api:x', 'db:y']);
  assert.deepEqual(a.levels, ['0:lo']);
  assert.equal(a.json, true);
  assert.equal(a.fresh, true);
});

test('answer readers expose the number or die loudly', () => {
  assert.deepEqual(readNoul({ noul: 0.42 }), { p: 0.42 });
  assert.deepEqual(readChoice({ choice: 'api', probability: 0.9 }), { label: 'api', p: 0.9 });
  assert.deepEqual(readChoice({ label: 'db' }), { label: 'db', p: 1 });
  assert.deepEqual(readScore({ score: 2.4 }), { s: 2.4 });
  assert.throws(() => readNoul({ wrong: 1 }), /unexpected noul/);
  assert.throws(() => readChoice({ nope: 1 }), /unexpected choice/);
  assert.throws(() => readScore({ nope: 1 }), /unexpected score/);
});

test('cacheKey separates model, command, spec and line', () => {
  const a = cacheKey('m1', 'noul', 'q', 'line');
  assert.equal(a, cacheKey('m1', 'noul', 'q', 'line'));
  assert.notEqual(a, cacheKey('m2', 'noul', 'q', 'line'));
  assert.notEqual(a, cacheKey('m1', 'score', 'q', 'line'));
  assert.notEqual(a, cacheKey('m1', 'noul', 'q2', 'line'));
  assert.notEqual(a, cacheKey('m1', 'noul', 'q', 'line2'));
});

test('pathPrefix takes the grep path, or the whole line when there is no colon', () => {
  assert.equal(pathPrefix('src/a/b.ts:12:const x = 1'), 'src/a/b.ts');
  assert.equal(pathPrefix('src/a/b.ts'), 'src/a/b.ts');
  assert.equal(pathPrefix(':weird-start'), ':weird-start'); // a colon at 0 is not a path split
});

test('groupByPath counts rows per dir/file and sums the rest exactly', () => {
  const rows = [
    { line: 'src/a/1.ts:1:x' }, { line: 'src/a/2.ts:4:y' }, { line: 'src/a/1.ts:9:z' },
    { line: 'src/b/3.ts:2:w' }, { line: 'loose.txt' },
  ];
  const d = groupByPath(rows, 'dir', 1);
  assert.deepEqual(d.top, [['src/a', 3]]);
  assert.equal(d.groupCount, 3);
  assert.equal(d.selected, 5);
  assert.equal(d.rest.reduce((s, [, n]) => s + n, 0), 2); // nothing dropped by the cap
  const f = groupByPath(rows, 'file', 10);
  assert.equal(f.groupCount, 4);
  assert.deepEqual(f.top[0], ['src/a/1.ts', 2]);
});

test('Argv reads --by-dir/--by-file in both forms, with the default cap', () => {
  assert.equal(new Argv(['q', '--by-dir', '12']).byDir, 12);
  assert.equal(new Argv(['q', '--by-file=7']).byFile, 7);
  const a = new Argv(['--by-dir', 'the question', '--top', '3']); // the question is not a count
  assert.equal(a.byDir, 15);
  assert.equal(a.pos[0], 'the question');
});

test('CLI: empty stdin is a loud non-zero, not a zero count', () => {
  const r = cli(['noul', 'is this the real thing?'], '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no candidates on stdin/);
});

test('CLI: choice with a single option dies before spending anything', () => {
  const r = cli(['choice', 'what is this?', '--opt', 'api:x'], 'a line\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /at least two options/);
});

test('CLI: no question dies with usage', () => {
  const r = cli(['noul'], '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs the question/);
});

test('CLI: unknown command prints usage', () => {
  const r = cli(['drift'], '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});

// --- run-path contracts, against a local mock of the Jev endpoint ---

// Answers every question with `verdict` ({noul: …} / {choice: …} / {score: …});
// returns the server (close it) and the URL for JEV_API_URL.
const serve = (verdict) => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { questions } = JSON.parse(body);
      const answers = Object.fromEntries(Object.keys(questions).map((q) => [q, verdict]));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answers, usage: { input_tokens: 10 } }));
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      server.unref(); // a keep-alive socket must not hold the test process open
      done({ server, url: `http://127.0.0.1:${server.address().port}` });
    })
  );
};

// Async spawn: spawnSync would freeze this process's event loop, starving the
// mock server these run-path tests need live while the child runs.
const cliEnv = (env, args, input) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input ?? '');
  });

test('CLI: --fresh skips cache reads but still merges its verdicts in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ noul: 0.9 });
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  const file = join(dir, 'jev', 'cache.json');
  const entries = () => Object.keys(JSON.parse(readFileSync(file, 'utf8')).entries).length;
  try {
    const r1 = await cliEnv(env, ['noul', 'question one'], 'a\nb\nc\n');
    assert.match(r1.stdout, /1 call\(s\)/);
    assert.equal(entries(), 3);
    const r2 = await cliEnv(env, ['noul', 'question two', '--fresh'], 'd\ne\n');
    assert.match(r2.stdout, /1 call\(s\)/); // fresh really re-asked
    assert.equal(entries(), 5); // and did not evict question one's entries
    const r3 = await cliEnv(env, ['noul', 'question two'], 'd\ne\n');
    assert.match(r3.stdout, /0 call\(s\)/); // fresh's verdicts were written
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: rows hidden by the 50-row cap say they are above the cut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ noul: 0.9 });
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  try {
    const input = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n') + '\n';
    const r = await cliEnv(env, ['noul', 'is this the real thing?'], input);
    // All 60 land above the cut (p >= 0.70); 50 shown, 10 hidden — all above it.
    assert.match(r.stdout, /10 more row\(s\) above the cut/);
    assert.doesNotMatch(r.stdout, /more row\(s\) below the cut/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a full cache hit is silent on stderr — no progress against 0 call(s)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ noul: 0.9 });
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  try {
    await cliEnv(env, ['noul', 'same question'], 'a\nb\nc\n'); // populate the cache
    const r2 = await cliEnv(env, ['noul', 'same question'], 'a\nb\nc\n');
    assert.match(r2.stdout, /0 call\(s\)/);
    assert.equal(r2.stderr, ''); // progress lines only accompany real calls
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --json keeps the banner on stderr — stdout parses as JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ noul: 0.9 });
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  try {
    const r = await cliEnv(env, ['noul', 'is this the real thing?', '--json'], 'a\nb\n');
    const j = JSON.parse(r.stdout); // throws if the banner leaked into stdout
    assert.equal(j.total, 2);
    assert.match(r.stderr, /2 candidate\(s\)/);
    assert.match(r.stderr, /yes 2 \/ 2 at p >= 0\.70/); // headline rides the banner, not just the JSON
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --json banner carries the group headline for choice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ choice: 'api' });
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  try {
    const r = await cliEnv(env, ['choice', 'what is this?', '--opt', 'api:x', '--opt', 'db:y', '--json'], 'a\nb\nc\n');
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.groups, [{ api: 3 }]);
    assert.match(r.stderr, /api 3/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: redirected stderr gets the banner only — no progress lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ noul: 0.9 });
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  try {
    const input = Array.from({ length: 1300 }, (_, i) => `line-${i}`).join('\n') + '\n'; // ~3 batches
    const r = await cliEnv(env, ['noul', 'is this the real thing?'], input);
    assert.match(r.stdout, /3 call\(s\)/);
    assert.doesNotMatch(r.stderr, /judged/); // progress is TTY-only; a piped run collects no `N/M judged` noise
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --by-dir/--by-file print the census in text and ride the JSON top level', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  const { server, url } = await serve({ noul: 0.9 }); // everything lands above the cut
  const env = { JEV_API_URL: url, JEV_API_KEY: 'test-key', XDG_CACHE_HOME: dir };
  try {
    const input = ['src/a/1.ts:1:x', 'src/a/2.ts:2:y', 'src/b/3.ts:3:z'].join('\n') + '\n';
    const r = await cliEnv(env, ['noul', 'real?', '--by-dir', '--by-file=5'], input);
    assert.match(r.stdout, /by dir: 2 group\(s\) holding 3 selected row\(s\)/);
    assert.match(r.stdout, /2\tsrc\/a/);
    assert.match(r.stdout, /by file: 3 group\(s\)/);
    const r2 = await cliEnv(env, ['noul', 'real?', '--json', '--by-dir'], input);
    const j = JSON.parse(r2.stdout);
    assert.deepEqual(j.byDir, { groups: 2, selected: 3, top: [{ 'src/a': 2 }, { 'src/b': 1 }] });
    assert.equal(j.byFile, undefined); // only the asked-for census ships
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
