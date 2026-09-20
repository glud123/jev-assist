#!/usr/bin/env node
// jev-assist — typed judgments over a codebase, via TypeSafe Jev.
//   rerank "<task>"   score every tracked file for relevance to a task (--json to dump the full ranking)
//   drift [glob]      scan files for convention drift
//   gate [ref]        judge a diff for risks linters cannot see
//   validate [n]      measure rerank recall against your own commit history
//   check             verify the stored key and the config's shape, offline
//   key <API_KEY>     store a key outside the repo at 0600
// Conventions and exemptions come from jev.config.json in the repo root.
// ponytail: sequential calls, no backoff. Add p-limit + 429 retry when pools exceed ~50 batches.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const exec = promisify(execFile);

const die = (msg) => {
  console.error(`jev: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- provider
// Several providers serve Jev. OpenRouter exposes it on its own Decisions endpoint, but the
// {state, model, questions} body and the {answers} response are byte-identical to direct — so
// only the URL, the key and the model id differ, making this a lookup rather than a translation
// layer. OpenRouter keys are recognisable by prefix; anything else is treated as direct.
// OpenRouter's optional HTTP-Referer / X-OpenRouter-Title ranking headers are skipped: a CLI
// has no site to rank. A provider that ever diverges in body shape needs a real adapter here.
export const provider = (key, env = {}) => {
  const or = key.startsWith('sk-or-');
  return {
    name: env.JEV_API_URL ? 'custom' : or ? 'openrouter' : 'typesafe',
    url: env.JEV_API_URL ?? (or ? 'https://openrouter.ai/api/alpha/decisions' : 'https://api.typesafe.ai/v1/systemone'),
    // `~` marks OpenRouter's floating alias, matching `jev-latest` direct. Pin with JEV_MODEL.
    model: env.JEV_MODEL ?? (or ? '~typesafe/jev-latest' : 'jev-latest'),
  };
};

// Stored outside the repo: a key in the working tree gets committed sooner or later.
export const keyPath = (env = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jev', 'key');

async function apiKey() {
  if (process.env.JEV_API_KEY?.trim()) return process.env.JEV_API_KEY.trim();
  try {
    return (await readFile(keyPath(), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function ask(state, questions) {
  const key = await apiKey();
  if (!key) die(`no API key. Run \`jev key <API_KEY>\`, or set JEV_API_KEY (looked in ${keyPath()})`);
  const p = provider(key, process.env);
  const t0 = performance.now();
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state, model: p.model, questions }),
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

// `git ls-files` pathspecs are NOT globs: by default `**` needs an intervening directory, so
// `src/**/*.ts` silently skips `src/main.ts`. The `:(glob)` prefix gives real glob semantics.
// Left alone if the caller already supplied pathspec magic.
export const pathspec = (p) => (p.startsWith(':') ? p : `:(glob)${p}`);
const tracked = async (globs) =>
  (await git(['ls-files', ...globs.map(pathspec)])).trim().split('\n').filter(Boolean);

// Exemptions are per-convention path substrings: a flag on an exempt path is dropped.
export const exempt = (cfg, key, path) => (cfg.exemptions?.[key] ?? []).some((frag) => path.includes(frag));

export const bar = (p) => (p >= 0.7 ? '!' : p >= 0.4 ? '?' : ' ');

// ---------------------------------------------------------------- check
// Shape only. A config can pass every line here and still ask the wrong questions —
// that is what the human review and `jev validate` are for.
export function configProblems(cfg) {
  const out = [];
  if (typeof cfg.description !== 'string' || cfg.description.length < 20)
    out.push('description: missing, or too short to orient the model');
  if (/REPLACE ME/i.test(cfg.description ?? '')) out.push('description: still the template placeholder');
  if (!Array.isArray(cfg.include) || !cfg.include.length) out.push('include: must be a non-empty array of globs');

  for (const group of ['conventions', 'gates']) {
    const entries = Object.entries(cfg[group] ?? {});
    if (!entries.length) out.push(`${group}: empty, so those checks do nothing`);
    const flag = group === 'conventions' ? 'drift' : 'risk';
    for (const [key, v] of entries) {
      for (const f of ['ask', flag, 'ok']) {
        if (typeof v?.[f] !== 'string' || v[f].length <= 10)
          out.push(`${group}.${key}.${f}: missing, or too short to steer the model`);
      }
      if (typeof v?.ask === 'string' && !v.ask.includes('?'))
        out.push(`${group}.${key}.ask: must be phrased as a question`);
    }
  }

  for (const key of Object.keys(cfg.exemptions ?? {}))
    if (!cfg.conventions?.[key]) out.push(`exemptions.${key}: names no convention, so it silently does nothing`);

  return out;
}

// ---------------------------------------------------------------- key
// Takes the key as an argument so an agent can store it for the user in one call. It lands
// outside the repo (never in the working tree) and 0600, and is echoed back masked.
async function key(value) {
  const k = value?.trim();
  if (!k) die('usage: jev key <API_KEY>   (stores it outside the repo, 0600)');
  if (k.length < 12) die('that does not look like an API key');
  const path = keyPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${k}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  const p = provider(k, process.env);
  console.log(`\n  stored ${k.slice(0, 6)}…${k.slice(-4)} in ${path} (0600)`);
  console.log(`  provider: ${p.name}  →  ${p.url}  (model ${p.model})`);
  console.log('  JEV_API_KEY in the environment still wins if set.');
}

async function check() {
  const k = await apiKey();
  if (!k) console.log(`\n  no API key — run \`jev key <API_KEY>\` (looked in ${keyPath()})`);
  else {
    const p = provider(k, process.env);
    console.log(`\n  key ${k.slice(0, 6)}…${k.slice(-4)}  provider ${p.name} → ${p.url} (model ${p.model})`);
  }

  const cfg = await config();
  const problems = configProblems(cfg);

  // An include glob matching nothing is the one fault that wastes money quietly: rerank and
  // drift score an empty pool and report success. Counting is the only way to see it.
  const globs = Array.isArray(cfg.include) ? cfg.include : [];
  const hits = new Set(); // a Set, because overlapping globs would otherwise be counted twice
  for (const g of globs) {
    const found = await tracked([g]);
    if (!found.length) problems.push(`include: "${g}" matches no tracked file`);
    for (const f of found) hits.add(f);
  }
  const matched = hits.size;

  if (!problems.length) {
    console.log(`\n  jev.config.json is well-formed. include matches ${matched} tracked file(s).`);
    console.log('  Shape only — run `jev validate` and read the questions yourself before trusting them.');
    if (!k) process.exitCode = 1;
    return;
  }
  console.log(`\n  ${problems.length} problem(s):`);
  for (const p of problems) console.log(`    - ${p}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- rerank
const LEVELS = [
  'Unrelated: no reason to open this file for the task.',
  'Background only: same app, but not touched and not a pattern to copy.',
  'Useful precedent: not touched, but shows the existing pattern to follow.',
  'Directly involved: likely must be read or edited to do the task.',
];

// Score every file for one task, highest first. Shared by rerank and validate.
async function score(task, files, cfg, quiet) {
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
    if (!quiet) {
      process.stderr.write(`  batch ${Math.floor(i / batch) + 1}/${Math.ceil(files.length / batch)}  ${r.ms}ms\n`);
    }
  }

  rows.sort((a, b) => b.score - a.score);
  return { rows, ms, tokens };
}

async function rerank(task, json) {
  if (!task) die('rerank needs a task description');
  const cfg = await config();
  const files = await tracked(cfg.include ?? ['**/*.ts', '**/*.tsx']);
  const { rows, ms, tokens } = await score(task, files, cfg);
  const top = rows.slice(0, cfg.topN ?? 20);
  console.log(`\n${files.length} files, ${ms}ms, ${tokens} input tokens\n`);
  for (const r of top) console.log(`  ${r.score.toFixed(2)}  ${r.path}`);
  console.log(
    '\n  Ranking is semantic, not exhaustive: files changed only by reference tend to rank low.\n' +
      '  Follow the imports of these before assuming the list is complete.'
  );
  // The printed top N is the whole point; the full ranking is only worth a file when
  // something will read past the cutoff. Opt in with --json.
  if (json) {
    await writeFile('.jev-rerank.json', JSON.stringify(rows, null, 1));
    console.log('  Full ranking written to .jev-rerank.json');
  }
}

// ---------------------------------------------------------------- validate
// Ground truth from git: a commit message is a task, the files it changed are the answer.
// Files the commit ADDED are excluded — they did not exist when the task was written, so
// rerank could never have surfaced them, and counting them inflates recall.
export const truthFrom = (nameStatus, rankable) =>
  nameStatus
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([status, path]) => status && path && status[0] !== 'A' && rankable.has(path))
    .map(([, path]) => path);

export const recallAt = (ranked, truth, k) => {
  if (!truth.length) return null;
  const top = new Set(ranked.slice(0, k));
  return truth.filter((p) => top.has(p)).length;
};

async function validate(n) {
  const count = Number(n ?? 10);
  if (!Number.isInteger(count) || count < 1) die('validate needs a positive commit count');
  const cfg = await config();
  const files = await tracked(cfg.include ?? ['**/*.ts', '**/*.tsx']);
  const rankable = new Set(files);
  const ks = cfg.validateK ?? [20, 40];

  const log = (await git(['log', '-n', String(count * 3), '--no-merges', '--format=%H\t%s'])).trim();
  const commits = log ? log.split('\n').map((l) => l.split('\t')) : [];
  if (!commits.length) die('no commits to validate against');

  const cases = [];
  for (const [sha, subject] of commits) {
    if (cases.length === count) break;
    if (!subject?.trim()) continue;
    const truth = truthFrom(await git(['show', '--no-renames', '--name-status', '--format=', sha]), rankable);
    if (truth.length) cases.push({ sha, subject, truth });
  }
  if (!cases.length) die('no commit touched a rankable file; check "include" in jev.config.json');

  console.log(`\n${files.length} rankable files, ${cases.length} commits, ${ks.join('/')} cutoffs\n`);
  const totals = Object.fromEntries(ks.map((k) => [k, 0]));
  let truthTotal = 0;
  let worst = null;

  for (const [i, c] of cases.entries()) {
    process.stderr.write(`  ${i + 1}/${cases.length}  ${c.sha.slice(0, 8)}\n`);
    const { rows } = await score(c.subject, files, cfg, true);
    const ranked = rows.map((r) => r.path);
    c.hits = Object.fromEntries(ks.map((k) => [k, recallAt(ranked, c.truth, k)]));
    truthTotal += c.truth.length;
    for (const k of ks) totals[k] += c.hits[k];
    const rate = c.hits[ks[0]] / c.truth.length;
    if (!worst || rate < worst.rate) worst = { ...c, rate };
  }

  const width = Math.max(...cases.map((c) => Math.min(c.subject.length, 44)));
  console.log(`  #  ${'task'.padEnd(width)}  truth  ${ks.map((k) => `@${k}`.padStart(4)).join('  ')}`);
  for (const [i, c] of cases.entries()) {
    const task = c.subject.length > 44 ? `${c.subject.slice(0, 41)}...` : c.subject;
    const cells = ks.map((k) => String(c.hits[k]).padStart(4)).join('  ');
    console.log(`  ${String(i + 1).padStart(1)}  ${task.padEnd(width)}  ${String(c.truth.length).padStart(5)}  ${cells}`);
  }

  console.log(
    `\n  ${ks.map((k) => `recall@${k} ${(totals[k] / truthTotal).toFixed(2)}`).join('   ')}` +
      `   (${truthTotal} files over ${cases.length} commits)`
  );
  console.log(`  worst: "${worst.subject.slice(0, 44)}" — ${worst.hits[ks[0]]}/${worst.truth.length}`);
  console.log(
    '\n  Recall is micro-averaged over files, so large commits weigh more.\n' +
      '  Files added by a commit are excluded: rerank could not have found what did not exist.\n' +
      '  Ranking happens against today\'s tree, so heavily refactored history reads low.'
  );
}

// ---------------------------------------------------------------- drift
async function drift(glob) {
  const cfg = await config();
  const convs = Object.entries(cfg.conventions ?? {});
  if (!convs.length) die('jev.config.json has no conventions');
  const files = await tracked(glob ? [glob] : (cfg.include ?? ['**/*.ts', '**/*.tsx']));
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
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const [cmd, arg] = argv.filter((a) => a !== '--json');
  const cmds = { rerank, drift, gate, validate, check, key };
  if (!cmds[cmd]) die('usage: jev <rerank|drift|gate|validate|check|key> [arg] [--json]');
  await cmds[cmd](arg, json);
}
