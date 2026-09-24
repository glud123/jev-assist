#!/usr/bin/env node
// jev — three typed judgments over a flood of candidates, via TypeSafe Jev.
// Candidates come in on stdin, one per line — the raw output of grep, glob, git,
// a test runner. What comes back is one calibrated number per candidate, sorted,
// with the total exact in a banner above the data and a cut line through it, so
// the reply is shorter than the input at any pool size.
//   key <API_KEY>               store the key outside the repo at 0600
//   noul '<statement>'          0-1 per candidate: is this one the real thing?
//   choice '<q>' --opt n:d ...  a label per candidate from a fixed set of options
//   score '<q>' --level n:d ... a rubric level per candidate
// Shared flags: --top N (rows above the cut), --by-file/--by-dir [N] (census of the
// selected rows by path), --json (every row), --fresh (skip cache reads).
// Finding candidates stays your job — grep, glob, git. This decides what each hit is.
// ponytail: the cache grows without eviction; if it ever matters, cap it by age at load.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const die = (msg) => {
  console.error(`jev: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- provider
// OpenRouter serves Jev on its Decisions endpoint; the {state, model, questions}
// body and {answers} response are identical to direct, so only url/key/model differ,
// selected by key prefix. JEV_API_URL / JEV_MODEL override for a gateway or a pin.
export const provider = (key, env = {}) => {
  const or = key.startsWith('sk-or-');
  return {
    name: env.JEV_API_URL ? 'custom' : or ? 'openrouter' : 'typesafe',
    url: env.JEV_API_URL ?? (or ? 'https://openrouter.ai/api/alpha/decisions' : 'https://api.typesafe.ai/v1/systemone'),
    model: env.JEV_MODEL ?? (or ? '~typesafe/jev-latest' : 'jev-latest'),
  };
};

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

async function ask(state, model, questions) {
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
  // `max_tokens_exceeded` is the one failure the caller can fix (it chose the batch
  // size), so it is thrown for `judge` to halve and retry. Everything else is fatal.
  if (res.status === 400 && body.includes('max_tokens_exceeded')) throw new Error('max_tokens_exceeded');
  if (!res.ok) die(`${res.status} ${body.slice(0, 400)}`);
  return { ...(await JSON.parse(body)), ms };
}

// ---------------------------------------------------------------- cache
// Jev is self-consistent (stable across repeated evaluations), so caching a verdict
// is sound, not a shortcut. On by default; `--fresh` recomputes, and its fresh
// verdicts still merge into the file — nothing already cached is evicted.
export const cachePath = (env = process.env) =>
  join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jev', 'cache.json');

export const cacheKey = (model, cmd, spec, line) =>
  createHash('sha256').update([model, cmd, spec, line].join('\x1f')).digest('hex');

async function loadCache() {
  try {
    const c = JSON.parse(await readFile(cachePath(), 'utf8'));
    return c?.version === 1 && c.entries ? c.entries : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- batching
// Questions in one request are bounded by tokens, not by count: 800 short lines went
// through in one call at 59k input tokens, 1500 came back max_tokens_exceeded. The
// documented 255 is the option limit of one Choice question — a different axis.
// ~74 tokens per question measured; the line's own text is a dozen of those, the
// question scaffolding is the bulk. 2 chars/token splits the difference between
// ASCII source (~4:1) and CJK (~1:1).
const TOKEN_BUDGET = 45_000;
const tokens = (l) => 70 + l.length / 2;
export const batchByTokens = (lines, budget = TOKEN_BUDGET) => {
  const out = [];
  let cur = [];
  let n = 0;
  for (const l of lines) {
    // A single line over budget still ships alone — one call that may fail loudly
    // beats a line silently dropped from the count.
    if (cur.length && n + tokens(l) > budget) (out.push(cur), (cur = []), (n = 0));
    cur.push(l);
    n += tokens(l);
  }
  if (cur.length) out.push(cur);
  return out;
};

// ---------------------------------------------------------------- candidates
export const readStdin = async () => {
  if (process.stdin.isTTY) die('no candidates on stdin. Pipe them in, one per line:\n  grep -rn "TODO" src | jev noul \'this TODO is still valid\'');
  const text = await new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
  // grep output carries a trailing newline; blank lines are not candidates.
  // Duplicates collapse with the count kept — two identical lines are one judgment,
  // and every total stays exact by naming both numbers.
  const all = text.split('\n').filter((l) => l.trim());
  const seen = new Map();
  for (const l of all) seen.set(l, (seen.get(l) ?? 0) + 1);
  const lines = [...seen.keys()];
  if (!lines.length) die('no candidates on stdin (the input was empty or blank)');
  return { lines, dupes: all.length - lines.length };
};

// ---------------------------------------------------------------- flags
// Flags may sit anywhere; both `--top 20` and `--top=20` work, because the shell
// delivers `--opt api:"..."` as two argv entries.
export class Argv {
  constructor(argv) {
    this.a = argv;
    this.pos = [];
    this.opts = [];
    this.levels = [];
    this.top = null;
    this.byFile = null;
    this.byDir = null;
    this.json = false;
    this.fresh = false;
    for (let i = 0; i < this.a.length; i++) {
      const t = this.a[i];
      const eq = t.includes('=') ? t.slice(t.indexOf('=') + 1) : null;
      if (t === '--json') { this.json = true; continue; }
      if (t === '--fresh') { this.fresh = true; continue; }
      if (/^--top(=|$)/.test(t)) {
        const n = Number(eq ?? this.a[++i]);
        if (!Number.isInteger(n) || n < 1) die('--top takes a positive count: --top 20');
        this.top = n;
        continue;
      }
      // --by-file/--by-dir take an optional cap: a following integer is the cap,
      // anything else (the question, another flag) leaves the default.
      if (/^--by-(file|dir)(=|$)/.test(t)) {
        const v = eq ?? this.a[i + 1];
        this[t.startsWith('--by-file') ? 'byFile' : 'byDir'] =
          /^\d+$/.test(v ?? '') ? Number(eq ?? this.a[++i]) : 15;
        continue;
      }
      if (/^--opt(=|$)/.test(t)) {
        const v = eq ?? this.a[++i];
        if (v === undefined) die('--opt needs a value: --opt name:criteria');
        this.opts.push(v);
        continue;
      }
      if (/^--level(=|$)/.test(t)) {
        const v = eq ?? this.a[++i];
        if (v === undefined) die('--level needs a value: --level 2:criteria');
        this.levels.push(v);
        continue;
      }
      this.pos.push(t);
    }
  }
}

// Split on the FIRST colon: criteria text is prose and may hold colons of its own.
export const parseOpt = (s, what) => {
  const i = s.indexOf(':');
  if (i < 1) die(`${what} needs name:criteria — '${s}' has no colon separating them`);
  return [s.slice(0, i), s.slice(i + 1).trim()];
};

export const parseOpts = (raw, what, flag) => {
  if (raw.length < 2) die(`${what} needs at least two options (a judgment between one option and nothing is not a judgment):\n  ${flag} name:criteria ${flag} other:criteria`);
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const [name, desc] = parseOpt(r, flag);
    if (seen.has(name)) die(`${flag} '${name}' given twice; options must be distinct`);
    if (!desc) die(`${flag} ${name}: criteria must be non-empty — it is what separates ${name} from the others`);
    seen.add(name);
    out.push([name, desc]);
  }
  return out;
};

export const parseLevels = (raw) => {
  if (!raw.length) die('score needs at least one level: --level 0:criteria --level 1:criteria');
  const byNum = new Map();
  for (const r of raw) {
    const [n, desc] = parseOpt(r, '--level');
    const num = Number(n);
    if (!Number.isInteger(num) || num < 0) die(`--level takes a non-negative integer before the colon, got '${n}'`);
    if (byNum.has(num)) die(`--level ${num} given twice`);
    if (!desc) die(`--level ${num}: criteria must be non-empty — it is what that level means`);
    byNum.set(num, desc);
  }
  return [...byNum].sort((a, b) => a[0] - b[0]);
};

// ---------------------------------------------------------------- answer readers
// Typed in, typed out — but the field names at the edge are the provider's, and a
// renamed field must fail loudly here rather than print `undefined` as a score.
export const readNoul = (a) => {
  const p = a?.noul ?? a?.probability;
  if (typeof p !== 'number') die(`unexpected noul answer: ${JSON.stringify(a)?.slice(0, 200)}`);
  return { p };
};
export const readChoice = (a) => {
  const label = a?.choice ?? a?.label ?? a?.option ?? a?.value;
  if (typeof label !== 'string') die(`unexpected choice answer (no label field): ${JSON.stringify(a)?.slice(0, 200)}`);
  const p = a?.probability ?? a?.confidence;
  return { label, p: typeof p === 'number' ? p : 1 };
};
export const readScore = (a) => {
  const s = a?.score;
  if (typeof s !== 'number') die(`unexpected score answer: ${JSON.stringify(a)?.slice(0, 200)}`);
  return { s };
};

// ---------------------------------------------------------------- the one judgment path
// Candidates ride in as N questions over one state; the shared question text sits in
// `state` once, not repeated per question. Concurrency 8 over a batch cursor, rows
// printed in input order. `max_tokens_exceeded` halves the slice and retries — the
// token estimate above is calibrated on one shape of line and will mis-estimate
// another (minified bundles, base64); a single line that still cannot fit dies
// loudly rather than dropping out of the count.
async function judge(cmd, state, model, spec, lines, makeQuestion, read, cache, progress) {
  const batches = batchByTokens(lines);
  const out = new Array(batches.length);
  let next = 0;
  let done = 0;
  let ms = 0;
  let inTok = 0;
  let calls = 0;

  const one = async (slice) => {
    const questions = Object.fromEntries(slice.map((l, n) => [`q${n}`, makeQuestion(l)]));
    try {
      const r = await ask(state, model, questions);
      ms += r.ms;
      inTok += r.usage?.input_tokens ?? 0;
      calls++;
      return slice.map((l, n) => read(r.answers[`q${n}`]));
    } catch (e) {
      if (e.message !== 'max_tokens_exceeded') throw e;
      if (slice.length === 1)
        die(`one candidate alone exceeds the request limit, so it cannot be judged:\n  ${slice[0].slice(0, 200)}`);
      progress(`  ${slice.length} candidates over the limit, splitting`);
      const half = slice.length >> 1;
      const [a, b] = await Promise.all([one(slice.slice(0, half)), one(slice.slice(half))]);
      return [...a, ...b];
    }
  };

  const worker = async () => {
    for (let b = next++; b < batches.length; b = next++) {
      const slice = batches[b];
      const hits = slice.map((l) => cache.get(cacheKey(model, cmd, spec, l)));
      const missIdx = hits.map((h, i) => (h === undefined ? i : -1)).filter((i) => i >= 0);
      if (missIdx.length) {
        const got = await one(missIdx.map((i) => slice[i]));
        missIdx.forEach((idx, n) => {
          cache.set(cacheKey(model, cmd, spec, slice[idx]), got[n]);
          hits[idx] = got[n];
        });
      }
      out[b] = slice.map((l, n) => ({ line: l, ...hits[n] }));
      done += slice.length;
      if (missIdx.length) progress(`  ${done}/${lines.length} judged`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, batches.length) }, worker));
  return { rows: out.flat(), ms, inTok, calls };
}

// ---------------------------------------------------------------- cut
// Where to stop reading. The cliff is the widest gap in the sorted probabilities —
// what calibration is for. Guards: a pool big enough for a gap to mean something,
// a gap big enough to be one, never a cut inside the top 3. `--top N` overrides.
export const cut = (ps, top) => {
  if (top != null) return { at: Math.min(top, ps.length), why: `--top ${top}` };
  const desc = [...ps].sort((a, b) => b - a);
  if (desc.length >= 8) {
    let best = -1;
    let gap = 0;
    for (let i = 3; i <= desc.length - 3; i++) {
      const g = desc[i - 1] - desc[i];
      if (g > gap) ((gap = g), (best = i));
    }
    if (gap >= 0.25) return { at: best, why: `cliff ${desc[best - 1].toFixed(2)}→${desc[best].toFixed(2)}` };
  }
  const t = desc.filter((p) => p >= 0.7).length;
  if (t) return { at: t, why: 'p >= 0.70' };
  return { at: Math.min(10, desc.length), why: 'no cliff, no p >= 0.70 — top 10' };
};

// ---------------------------------------------------------------- census
// jev already holds a verdict per row, so "where do they live" is arithmetic, not
// another call: group the selected rows by the path before the first colon (grep's
// `path:line:…` shape; a line with no colon is its own path) and count. Every total
// is exact — the rest beyond the cap is summed and named, never dropped.
// ponytail: POSIX separator assumed — a pool of `a\b` paths groups as one; and
// groups count rows only, no per-label breakdown. Add either when a task needs it.
export const pathPrefix = (line) => {
  const c = line.indexOf(':');
  return c > 0 ? line.slice(0, c) : line;
};

export const groupByPath = (rows, mode, cap) => {
  const m = new Map();
  for (const r of rows) {
    const p = pathPrefix(r.line);
    const k = mode === 'dir' ? p.slice(0, p.lastIndexOf('/')) || '.' : p;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const groups = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    groupCount: groups.length,
    selected: rows.length,
    top: groups.slice(0, cap),
    rest: groups.slice(cap),
  };
};

// ---------------------------------------------------------------- output
// Rows are TSV, the line JSON-quoted, so a line holding tabs or colons still
// round-trips through awk or cut.
const fmtRow = (r, levels) => {
  const text = JSON.stringify(r.line);
  if (r.p !== undefined && r.label !== undefined) return `${r.p.toFixed(2)}\t${r.label}\t${text}`;
  if (r.label !== undefined) return `${r.label}\t${text}`;
  if (r.p !== undefined) return `${r.p.toFixed(2)}\t${text}`;
  const lv = levels?.find(([n]) => n === Math.round(r.s));
  return `${r.s.toFixed(2)}\tL${Math.round(r.s)}${lv ? ` (${lv[1]})` : ''}\t${text}`;
};

const ROW_CAP = 50;
const printRows = (rows, levels, note) => {
  for (const r of rows.slice(0, ROW_CAP)) console.log(fmtRow(r, levels));
  if (rows.length > ROW_CAP)
    console.log(`  … ${rows.length - ROW_CAP} more row(s) ${note} — --json prints every row; a re-run is a cache hit`);
};

// Census of the rows the answer points at (above the cut for noul; all of them for
// choice/score, which has no cut). JSON gets the slim shape; text gets the table.
const censusOf = (argv, selected) => {
  if (!argv.byDir && !argv.byFile) return null;
  return {
    ...(argv.byDir ? { byDir: groupByPath(selected, 'dir', argv.byDir) } : {}),
    ...(argv.byFile ? { byFile: groupByPath(selected, 'file', argv.byFile) } : {}),
  };
};
const slimCensus = (g) => ({
  groups: g.groupCount,
  selected: g.selected,
  top: g.top.map(([k, n]) => ({ [k]: n })),
  ...(g.rest.length
    ? { restGroups: g.rest.length, restRows: g.rest.reduce((s, [, n]) => s + n, 0) }
    : {}),
});
const printCensus = (census) => {
  if (!census) return;
  for (const [label, g] of [['by dir', census.byDir], ['by file', census.byFile]]) {
    if (!g) continue;
    console.log(`  ${label}: ${g.groupCount} group(s) holding ${g.selected} selected row(s); top ${g.top.length}:`);
    for (const [k, n] of g.top) console.log(`    ${n}\t${k}`);
    if (g.rest.length)
      console.log(`    ${g.rest.reduce((s, [, n]) => s + n, 0)}\t… ${g.rest.length} more group(s)`);
  }
};

async function run(cmd, question, spec, makeQuestion, read, levels, argv) {
  const { lines, dupes } = await readStdin();
  const key = await apiKey();
  if (!key) die(`no API key. Run \`jev key <API_KEY>\`, or set JEV_API_KEY (looked in ${keyPath()})`);
  const model = provider(key, process.env).model;

  // --fresh bypasses reads (every line re-judged) but never the merge: what is
  // already on disk belongs to other questions and pools, not to this run.
  const disk = await loadCache();
  const stored = argv.fresh ? {} : disk;
  const cache = new Map();
  for (const l of lines) {
    const h = cacheKey(model, cmd, spec, l);
    if (stored[h] !== undefined) cache.set(h, stored[h]);
  }
  const hits = cache.size;

  const t0 = performance.now();
  const { rows, ms, inTok, calls } = await judge(
    cmd, { question }, model, spec, lines, makeQuestion, read, cache,
    // Live progress is for a watching eye only; redirected stderr collects the
    // banner alone, so a file (or a pipe) never fills with `N/M judged` lines.
    (s) => { if (process.stderr.isTTY) process.stderr.write(`${s}\n`); }
  );
  const wall = Math.round(performance.now() - t0);

  // Merge over what was on disk: this run's lines must not evict anyone else's.
  if (cache.size > hits) {
    const entries = { ...disk, ...Object.fromEntries(cache) };
    await mkdir(dirname(cachePath()), { recursive: true, mode: 0o700 });
    await writeFile(cachePath(), JSON.stringify({ version: 1, entries }));
  }

  const banner =
    `jev ${cmd} · ${lines.length} candidate(s)${dupes ? ` (${dupes} duplicate line(s) collapsed)` : ''}` +
    ` · ${calls} call(s) · ${wall}ms · ${inTok} input tok · ${hits}/${lines.length} cache hit(s)\n` +
    `  "${question}"`;

  if (cmd === 'noul') {
    rows.sort((a, b) => b.p - a.p);
    const c = cut(rows.map((r) => r.p), argv.top);
    const yes = rows.filter((r) => r.p >= 0.7).length;
    // The headline rides the banner in every mode. A consumer re-deriving it
    // from rows references `cut` inside `.rows[]`, where it is null — and any
    // comparison against that null lies silently (`p >= null` keeps every row,
    // `p < null` keeps none). Truth ships beside whatever recomputes it.
    const headline = `yes ${yes} / ${rows.length} at p >= 0.70`;
    const census = censusOf(argv, rows.slice(0, c.at));
    if (argv.json) {
      process.stderr.write(`${banner}\n  ${headline}\n`); // metadata, not data — stdout stays pure JSON so `| jq` just works
      console.log(JSON.stringify({ cmd, question, total: rows.length, yes, cut: c,
        ...(census?.byDir ? { byDir: slimCensus(census.byDir) } : {}),
        ...(census?.byFile ? { byFile: slimCensus(census.byFile) } : {}), rows }, null, 1));
      return;
    }
    console.log(`${banner}\n  ${headline}`);
    printCensus(census);
    if (c.at < rows.length)
      console.log(`  --- cut: read above (${c.at} row(s); ${c.why}; ${rows.length - c.at} below) ---`);
    printRows(rows.slice(0, c.at), levels, 'above the cut');
    return;
  }

  // choice/score are labels, not one continuum, so there is no global cut: group by
  // the answer itself — every group's count is in the banner, so nothing hides.
  const getKey = cmd === 'choice' ? (r) => r.label : (r) => `L${Math.round(r.s)}`;
  const groups = new Map();
  for (const r of rows) {
    const k = getKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const order =
    cmd === 'choice'
      ? [...groups].sort((a, b) => b[1].length - a[1].length)
      : [...groups].sort((a, b) => Number(b[0].slice(1)) - Number(a[0].slice(1)));
  const headline = order.map(([k, g]) => `${k} ${g.length}`).join('  ·  ');
  const census = censusOf(argv, rows);
  if (argv.json) {
    process.stderr.write(`${banner}\n  ${headline}\n`); // metadata, not data — stdout stays pure JSON so `| jq` just works
    console.log(JSON.stringify({ cmd, question, total: rows.length, groups: order.map(([k, g]) => ({ [k]: g.length })),
      ...(census?.byDir ? { byDir: slimCensus(census.byDir) } : {}),
      ...(census?.byFile ? { byFile: slimCensus(census.byFile) } : {}), rows }, null, 1));
    return;
  }
  console.log(`${banner}\n  ${headline}`);
  printCensus(census);
  for (const [k, g] of order) {
    g.sort((a, b) => (b.p ?? b.s) - (a.p ?? a.s));
    console.log(`\n[${k}]  ${g.length} candidate(s)`);
    printRows(g, levels, `in ${k}`);
  }
}

// ---------------------------------------------------------------- key
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

const usage = () =>
  die(
    'usage:\n' +
      '  jev key <API_KEY>\n' +
      "  ...candidates | jev noul '<statement about one candidate>'\n" +
      "  ...candidates | jev choice '<question>' --opt name:criteria [--opt ...]\n" +
      "  ...candidates | jev score '<question>' --level 0:criteria [--level ...]\n" +
      '  flags: --top N · --by-file/--by-dir [N] (census of selected rows by path) · --json (every row) · --fresh (recompute, skip cache reads)'
  );

// Only dispatch when run as a CLI; tests import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'key') await key(rest[0]);
  else if (cmd !== 'noul' && cmd !== 'choice' && cmd !== 'score') usage();
  else {
    const argv = new Argv(rest);
    const question = argv.pos[0];
    if (!question) die(`${cmd} needs the question as the first argument, then candidates on stdin`);
    if (cmd === 'noul')
      await run('noul', question, question, (l) => ({ type: 'noul', instructions: l, criteria: { true: 'yes', false: 'no' } }), readNoul, null, argv);
    else if (cmd === 'choice') {
      const opts = parseOpts(argv.opts, 'choice', '--opt');
      const criteria = Object.fromEntries(opts);
      await run('choice', question, `${question}\x1f${JSON.stringify(criteria)}`, (l) => ({ type: 'choice', instructions: l, criteria }), readChoice, opts, argv);
    } else {
      const levels = parseLevels(argv.levels);
      await run('score', question, `${question}\x1f${JSON.stringify(levels)}`, (l) => ({ type: 'score', instructions: l, criteria: levels.map(([, d]) => d) }), readScore, levels, argv);
    }
  }
}
