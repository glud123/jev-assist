#!/usr/bin/env node
// jev-assist — typed judgments over a codebase, via TypeSafe Jev.
//   rerank "<task>"   score every tracked file for relevance to a task
//   drift [glob]      scan files for convention drift
//   gate [ref]        judge a diff for risks linters cannot see
// Conventions and exemptions come from jev.config.json in the repo root.
// ponytail: sequential calls, no backoff. Add p-limit + 429 retry when pools exceed ~50 batches.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const API = 'https://api.typesafe.ai/v1/systemone';
const KEY = process.env.JEV_API_KEY;

const die = (msg) => {
  console.error(`jev: ${msg}`);
  process.exit(1);
};

async function ask(state, questions) {
  if (!KEY) die('JEV_API_KEY is not set');
  const t0 = performance.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state, model: 'jev-latest', questions }),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.text();
  if (!res.ok) die(`${res.status} ${body.slice(0, 400)}`);
  const json = JSON.parse(body);
  return { ...json, ms };
}

async function config() {
  try {
    return JSON.parse(await readFile('jev.config.json', 'utf8'));
  } catch {
    die('no jev.config.json in the current directory (see README)');
  }
}

const git = async (args) => (await exec('git', args, { maxBuffer: 1 << 28 })).stdout;
const tracked = async (globs) => (await git(['ls-files', ...globs])).trim().split('\n').filter(Boolean);

// Exemptions are per-convention path substrings: a flag on an exempt path is dropped.
export const exempt = (cfg, key, path) => (cfg.exemptions?.[key] ?? []).some((frag) => path.includes(frag));

export const bar = (p) => (p >= 0.7 ? '!' : p >= 0.4 ? '?' : ' ');

// ---------------------------------------------------------------- rerank
const LEVELS = [
  'Unrelated: no reason to open this file for the task.',
  'Background only: same app, but not touched and not a pattern to copy.',
  'Useful precedent: not touched, but shows the existing pattern to follow.',
  'Directly involved: likely must be read or edited to do the task.',
];

async function rerank(task) {
  if (!task) die('rerank needs a task description');
  const cfg = await config();
  const files = await tracked(cfg.include ?? ['*.ts', '*.tsx']);
  const batch = cfg.batchSize ?? 60;
  const rows = [];
  let ms = 0;
  let tokens = 0;

  for (let i = 0; i < files.length; i += batch) {
    const slice = files.slice(i, i + batch);
    const questions = Object.fromEntries(
      slice.map((path, n) => [
        `f${n}`,
        { type: 'score', instructions: { path, question: 'How relevant is this file to the task?' }, criteria: LEVELS },
      ])
    );
    const r = await ask({ task, repo: cfg.description ?? '' }, questions);
    slice.forEach((path, n) => rows.push({ path, ...r.answers[`f${n}`] }));
    ms += r.ms;
    tokens += r.usage.input_tokens;
    process.stderr.write(`  batch ${Math.floor(i / batch) + 1}/${Math.ceil(files.length / batch)}  ${r.ms}ms\n`);
  }

  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, cfg.topN ?? 20);
  console.log(`\n${files.length} files, ${ms}ms, ${tokens} input tokens\n`);
  for (const r of top) console.log(`  ${r.score.toFixed(2)}  ${r.path}`);
  console.log(
    '\n  Ranking is semantic, not exhaustive: files changed only by reference tend to rank low.\n' +
      '  Follow the imports of these before assuming the list is complete.'
  );
  await writeFile('.jev-rerank.json', JSON.stringify(rows, null, 1));
}

// ---------------------------------------------------------------- drift
async function drift(glob) {
  const cfg = await config();
  const convs = Object.entries(cfg.conventions ?? {});
  if (!convs.length) die('jev.config.json has no conventions');
  const files = await tracked(glob ? [glob] : (cfg.include ?? ['*.ts', '*.tsx']));
  const questions = Object.fromEntries(
    convs.map(([k, c]) => [k, { type: 'noul', instructions: c.ask, criteria: { true: c.drift, false: c.ok } }])
  );

  let flagged = 0;
  for (const path of files) {
    const state = await readFile(path, 'utf8');
    const r = await ask(state, questions);
    const hits = Object.entries(r.answers)
      .filter(([k, v]) => v.noul >= (cfg.threshold ?? 0.7) && !exempt(cfg, k, path))
      .sort((a, b) => b[1].noul - a[1].noul);
    if (!hits.length) continue;
    flagged++;
    console.log(`\n${path}`);
    for (const [k, v] of hits) console.log(`  ${bar(v.noul)} ${v.noul.toFixed(2)}  ${k}`);
  }
  console.log(`\n${flagged}/${files.length} files flagged.`);
  console.log('  Verify each before acting: a correct flag can still be a deliberate choice.');
}

// ---------------------------------------------------------------- gate
async function gate(ref) {
  const cfg = await config();
  const gates = Object.entries(cfg.gates ?? {});
  if (!gates.length) die('jev.config.json has no gates');
  const diff = ref ? await git(['show', ref]) : await git(['diff', '--cached']);
  if (!diff.trim()) die(ref ? `${ref} has no diff` : 'nothing staged');

  const questions = Object.fromEntries(
    gates.map(([k, g]) => [k, { type: 'noul', instructions: g.ask, criteria: { true: g.risk, false: g.ok } }])
  );
  const r = await ask(diff, questions);
  const rows = Object.entries(r.answers).sort((a, b) => b[1].noul - a[1].noul);
  const threshold = cfg.threshold ?? 0.7;
  const hits = rows.filter(([, v]) => v.noul >= threshold);

  console.log(`\n${ref ?? 'staged'}  ${(diff.length / 1024).toFixed(1)}KB  ${r.ms}ms`);
  for (const [k, v] of rows) console.log(`  ${bar(v.noul)} ${v.noul.toFixed(2)}  ${k}`);
  if (!hits.length) {
    console.log('\n  pass');
    return;
  }
  console.log(`\n  ${hits.length} flag(s) to review:`);
  for (const [k] of hits) console.log(`    - ${cfg.gates[k].risk}`);
  console.log('\n  These are prompts for a human look, not verdicts. Exit 1 so hooks can stop.');
  process.exitCode = 1;
}

// Only dispatch when run as a CLI, so tests can import the helpers above.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const cmds = { rerank, drift, gate };
  if (!cmds[cmd]) die('usage: jev <rerank|drift|gate> [arg]');
  await cmds[cmd](arg);
}
