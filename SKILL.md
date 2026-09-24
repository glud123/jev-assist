---
name: jev-assist
description: "Use when a search or list comes back as a flood — hundreds of grep hits, changed files, TODOs, failing tests, diff hunks — or when you are about to write `grep -v`, to eyeball-skip rows, or to read hundreds of matches into context: you need to know which ones actually count, what each one is, or how bad each is, without reading them all. `jev noul|choice|score` takes the candidates on stdin and returns one calibrated number per candidate, sorted, with a cut line and an exact total, so you read a dozen rows instead of the whole pool. Finding candidates stays your job; this decides what each hit is."
---

# jev-assist

You already ran the search. It came back as 3,000 lines, or 500 files — too many to read, too
expensive to guess at. A pattern cannot carry the judgment (`grep -v` on a comment syntax counts
commented-out code as live and reports the wrong number as a finding), and reading the pool
empties the context window before the task is done.

jev deletes that trade. Pipe the candidates in; what comes back is **one calibrated number per
candidate, sorted, with the exact total and a cut line** — the same ~30 lines whether the pool
was 40 or 4,000. Search says where a hit is; this decides what each hit *is*. Finding things
stays your job — nothing here searches.

## The contract

One shape, three judgments — the subcommand picks the type of the number:

```sh
<however you found them> | jev <noul|choice|score> <question definition>
```

- **In:** stdin, one candidate per line. Raw `grep -rn`, `git diff --name-only`, `git ls-files`,
  a test runner's failure lines — no reformatting.
- **Out:** a banner first (exact candidate count, calls, ms, tokens, cache hits, then the
  headline — the yes count at the cut for `noul`, the group sizes for `choice`/`score`;
  every number is over the full pool, never a cap), then rows sorted by the number, then a
  cut line. Read above the cut; that is the answer.
- **Rows are TSV**, the line JSON-quoted, so `awk`/`cut` still work on them.

The three judgments:

- `noul '<statement about one candidate>'` — 0–1 per candidate, the flood filter.
- `choice '<q>' --opt name:criteria ...` — a label per candidate from a small fixed set.
- `score '<q>' --level 0:criteria ...` — a rubric level per candidate, ordered severity.

```sh
grep -rn "getUser" src/ | jev noul 'this line calls the user API in production code, not a test, mock, or comment'
git ls-files 'src/**' | jev choice 'what layer does this file belong to?' --opt api:"HTTP handler or route" --opt db:"schema, migration, or query" --opt ui:"component or view"
grep -rn "TODO\|FIXME" src/ | jev score 'is this TODO still valid?' --level 0:"stale, the code moved on" --level 1:"valid, minor" --level 2:"valid and blocking a known bug"
```

The judgment is per candidate, and the candidate is one line. That is the unit: a line of
`grep` output, a path, a hunk you extracted with `git diff -U0`. Do not feed whole files —
60 lines of a file is one batched call, a whole file is one call per file, for the same
question (route on the object of the judgment).

Flags: `--top N` fixes the cut; `--by-file N` / `--by-dir N` add a census of the selected
rows — counts per path (the text before the first colon) or per directory, top N with the
rest summed exactly — so a flood's distribution costs one flag, not post-processing passes;
`--json` prints every row uncapped (banner and headline on stderr, stdout is pure JSON;
`byFile`/`byDir` ride the top level when asked); `--fresh` re-judges the pool but still
merges its verdicts into the cache — nothing already cached is evicted.
There is no search flag on purpose — if you catch yourself looking for one, the job you are
describing is a grep.

A pool of a few thousand lines takes tens of seconds: run the call in the foreground with a
generous timeout. Backgrounding it spends an extra round trip to hide a wait you would pay
anyway.

The `--json` shape: `{total, yes?, cut?, groups?, rows}` — one field per row: `p` for noul,
`label` for choice, `s` for score; `cut.at` counts the rows above the cut and `cut.why`
states the threshold as a string. The headline lives on the top level and the banner — never
recompute it from `.rows[]`: inside a row those fields are null, and a comparison against
that null lies silently. Filter with the literals from `cut.why` (`p >= 0.70`), and check
any recomputed number against the banner before reporting it.

## Route by what you already ran

| You just ran | Candidates are | Use | Question shape |
|---|---|---|---|
| `grep -rn <symbol>` | matched lines | `noul` | is this line really doing X |
| `git diff --name-only` | changed files | `noul` | is this change risky |
| `git diff` (split into hunks) | hunks | `score` | how severe is each |
| `git ls-files` | paths | `choice` | which layer/module owns it |
| a test run | failures | `choice` | flake / real bug / environment |
| `grep -rn "TODO\|FIXME"` | todos | `score` | still valid? how bad |

And the reflex to replace: **the moment you are about to write `grep -v`, or to eyeball-skip
rows because there are too many, run the pool through `jev noul` instead.** An exclusion
pattern is a guess wearing a number; a noul verdict is the judgment the pattern cannot carry.
The pool's provenance does not matter — a raw grep, a script you wrote to shape the search, a
test runner's output. When judging each line by hand costs more than one piped call, pipe it.

## Phrasing the question

- **One hop.** "Is this user-facing copy?" works; "does this file contain copy that should be
  migrated before the launch that follows the audit?" does not.
- **Literal.** It answers the words you wrote. Write the exclusion in: `'...in production code,
  not a test, mock, or comment'` — the "not" clause is doing real work.
- **noul takes a statement about one candidate** ("this line ..."), choice and score take a
  question ("what layer is this?").
- **Choice options need contrastive criteria** — say what separates each label from its
  neighbors, not just what it is. Two options minimum.
- **Score levels must be mutually exclusive** descriptions, lowest number first. Use score when
  the levels carry meaning; use choice when they are just names.
- **Short candidates score systematically lower** — a bare label, aria text, or enum value
  carries too little context to judge confidently, in any language; CJK text aggravates it.
  Spot-check a handful by eye before reporting a pool full of them as fact.

## What the number is

Calibrated probability, not a vibe and not a verdict. Read magnitudes: 0.97 means it, the cut
line is where the pool actually separates. The band between ~0.4 and the cut is a second pool,
not noise: if it holds more than a screenful, don't eyeball it — filter those rows out of the
`--json` output and pipe their lines back through `choice`, criteria contrasting on what each
candidate *is* — a different axis than the first question asked, and carrying the first
question's exclusions into the option criteria (a comment is still not a candidate on the
second axis). When a re-pipe is plausible the first pass runs with `--json` — text output is
for reading, rows are for merging: `jq -r '.rows[] | select(.label=="x") | .line'`.
The re-pipe only pays when
that axis exists: a band of short candidates has no second axis to offer it, so a screenful
or two of those, just read. That is where shape-deceptive
hits live: a line whose shape hides its payload, a config entry whose value renders
(`label: "Status"`). Report the band as a counted flag beside the cut answer, never folded into
either.

The below-cut pool gets one cheap audit before you report it as clean, when it is large:
write a single shape probe — a regex matching what a true positive would look like in this
pool's own format (an assignment, a call, a value in a config) — and run it over the negative
rows. Confirm the probe fires before trusting it: run it over the yes rows first, where it
must match — a probe that silently matches nothing reports the pool as clean on a broken
instrument. A handful of hits, read them all; many, report the hit count as a counted flag
beside the cut answer, never folded into it. The verdicts are evidence about the question you
asked, not a seal on the pool: a shape the question could not see is exactly what a pattern
can still find.

Counts in the banner are computed from per-candidate verdicts in plain JS — the model
is never asked "how many", because it cannot count.

Known failure modes, all measured: short or low-context candidates score low (CJK more so); irrelevant context in a candidate
distracts (send the line, not its file); multi-hop questions degrade; comments and fixtures in
the repo can move an answer (no prompt-injection defence); noul and choice numbers are not
comparable — never mix them in one ranking.

## Setup

```sh
jev key sk-or-v1-...
```

The key lands in `~/.config/jev/key` at 0600, outside the repo; `JEV_API_KEY` in the
environment wins. Never write a key into a tracked file; never echo it in full.

**Do not pre-flight the key — the first call is the check.** Without a key, a judgment call
dies in milliseconds with the path it looked at; that is the moment to stop and ask the user
for one. A separate existence check spends a round trip on information the call gives you
for free.

There is no per-project config. The question is the interface — it rides on the command line,
which is why the same binary works on any repo.

**Invoking:** `jev` is on PATH only if `npm link`/`npm i -g` was run. Installed as a skill it
is not — call the script by absolute path:

```sh
node "/absolute/path/to/jev-assist/scripts/jev.mjs" noul '...' < candidates
```

Nothing sets `$SKILL_DIR` for you; substitute the real path. The working directory is the
repo being judged.

## When not to reach for it

- **Retrieval.** Finding where something is: `grep`/`rg`/`Glob`. Nothing here searches.
- **Small pools.** Under ~a dozen candidates you can read: read them. A round trip buys
  nothing over your own eyes, and you can act on what you read.
- **One candidate.** Same rule, sharper: n=1 is your judgment to make, with context jev
  does not have.
- **What a compiler, linter, or test decides.** Those are authoritative and free. jev is for
  the judgment they structurally cannot see.
- **Candidates you just generated yourself.** The probability then measures your own
  self-consistency, not an outside opinion.

## What leaves the machine

Each call sends the candidate lines, the question, and the API key to the Jev endpoint.
Verdicts are cached locally keyed by question+line — jev is self-consistent, so a cached
verdict is the verdict; `--fresh` recomputes. If the repo must not leave the machine, do not
point jev at it. Provider detail and uninstall steps: [README.md](README.md).
