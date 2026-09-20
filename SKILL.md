---
name: jev-assist
description: Rank every file in a repo by relevance to a task, so you read the right files instead of grepping for keywords. Use this FIRST when starting work in a repo too large to read, or when you do not know which files a task touches. Also scans for convention drift and gates diffs on risks linters cannot see, and measures its own accuracy against the repo's commit history.
---

# jev-assist

Jev answers closed questions about code and returns probabilities, not prose. That makes it
useful for judgments that are worth making a few hundred times and worthless to make once:
which files matter for a task, which files drifted from a convention, whether a diff touches
something dangerous.

It is not a better reasoner than the agent driving it. It is a cheap way to apply one
judgment across a pool too large to read. Use it where the pool is large; decide yourself
where the pool is small.

## Setup

Needs an API key and a `jev.config.json` in the repo root.

**The key.** If the user hands you a key, store it for them — do not ask them to run `export`:

```sh
jev key sk-or-v1-...
```

It lands in `~/.config/jev/key` at 0600 (`$XDG_CONFIG_HOME` honoured), outside the repo, because
a key in the working tree eventually gets committed. `JEV_API_KEY` in the environment still wins
when set. Never paste a key into `jev.config.json`, a shell rc file, or any tracked file, and
never echo it back in full — `jev key` prints it masked.

The provider is derived from the key: one starting `sk-or-` routes to OpenRouter's Decisions
endpoint (`~typesafe/jev-latest`), anything else to TypeSafe direct (`jev-latest`). The
`{state, model, questions}` body and `{answers}` response are identical either way, so nothing
else changes. For a self-hosted gateway or a pinned version, set `JEV_API_URL` and `JEV_MODEL`;
those override the derived values. `jev check` prints which provider is in play — read it before
debugging a call, since a wrong-provider key fails as a plain 401.

**The config.** If the repo has no `jev.config.json`, **write one, then hand it to the user to
review** — do not copy the example across unedited. Its conventions name i18next, TanStack
Query and `src/services`, and in a repo without those it asks three questions that cannot be
true.

Read `$SKILL_DIR/jev.config.example.json` for the shape, then derive the content from the repo:

- **`description`** — one line on what the app is and which libraries the conventions below
  name. Read the manifest (`package.json`, `go.mod`, `pyproject.toml`) rather than guessing.
- **`include`** — globs covering the source the repo actually has. Confirm with
  `git ls-files <glob> | wc -l`; a glob matching nothing makes `rerank` silently score zero files.
- **`conventions`** — only rules this codebase actually follows, found by reading it: the
  shared request wrapper, the state library, the i18n setup. A convention the repo never
  adopted flags every file and teaches the user to ignore the output. Three or four real ones
  beat ten aspirational ones. Anchor each `ask` to the concrete module (`the wrapper in
  src/services`), never to a principle.
- **`gates`** — the risks that fit this repo. `auth_or_crypto` and `data_loss` travel well;
  name the actual surface (which module holds payments, what counts as PII here).
- **`exemptions`** — path fragments for the places a convention is legitimately violated:
  mocks, fixtures, the wrapper module itself.

Then verify, in this order:

```sh
jev check         # shape: placeholders, empty groups, exemptions naming no convention
jev drift         # a first pass — read the flags yourself before showing anyone
jev validate 20   # is rerank accurate on this repo at all?
```

`jev check` is mechanical. It passes on a config asking confidently wrong questions, so it
gates the handoff, it does not substitute for it. Run `drift` on a handful of files whose
answer you already know: a convention that flags nearly everything or nothing is miscalibrated,
and the fix is in the `ask`/`ok` text, not the threshold. Bring the user the config plus what
that pass found, and say which conventions you inferred from reading code versus which you
guessed — the guesses are what they should look at first.

Conventions and gates are per-project on purpose — see "Why the config is per-project" below.

**Invoking the CLI.** `jev` is on PATH only after `npm link`. Installed as a skill it is not,
so run the script by path from the repo you are judging:

```sh
node "$SKILL_DIR/scripts/jev.mjs" validate 20
```

`$SKILL_DIR` is this file's directory. Below, `jev` is shorthand for that command; the working
directory is always the repo being judged, never the skill directory.

## The commands

### `jev rerank "<task>"` — before writing code

Scores every tracked file for relevance to a task, prints the top N. Use at the start of
work in a repo you do not know by heart, to find the files worth reading.

Measured on one private 705-file React app, 10 consecutive commits as tasks, ground truth from
what each commit actually changed: **recall@20 0.68, recall@40 0.80** over 41 files. One call
per 60 files, ~16s and ~93k input tokens for the full repo.

It earns its keep on files that share no keyword with the task. In that test,
a shared upload service ranked 6th for an image-upload task in an unrelated feature — a
cross-layer file that grep on either feature name or `upload` would have missed or buried.

**Where it fails:** files changed only because a reference changed rank low (one ground-truth
file landed at 121/705). Semantic scoring cannot see structural coupling, and it shows up as a
size effect: in that run every task touching 1–4 files scored full marks, while an 11-file
change reached 5/11. Treat the top 20 as the core of a change, never the whole of it, and
follow the imports of those files before assuming the list is complete.

**Reading the list:** `topN` is a fixed row count, not a relevance filter. A task touching 3
files still prints 20 rows, and the rest are the least unrelated files in the repo rather than
candidates. Cut at the gap in the scores — they are a distribution over four levels from
"no reason to open this file" to "likely must be read or edited", so 0.3 means background.

Stdout is the interface; nothing is written to disk. Add `--json` only if you need the ranking
past the cutoff, which also dumps every row to `.jev-rerank.json` in the repo root — tell the
user to gitignore it if they do not already.

Run once per task, not per edit. 16s is fine at the start of work and wrong inside a loop.

### `jev validate [n]` — before trusting any of this on a new repo

Replays the last n commits as tasks and scores `rerank` against what each commit actually
changed. Run it once per repo, before relying on a ranking you cannot check.

```sh
jev validate 20
```

Recall does not transfer between repos. A number measured on a 705-file React app says
nothing about a Go monolith, and a confident 0.87 on a file is unfalsifiable on its own.
This makes it falsifiable using history the repo already has.

Read the `worst:` line as carefully as the recall figure. Dependency bumps and sweeping
renames have no semantic signal and score low by nature — that is a fact about the task, not
a defect. It tells you when to skip `rerank` entirely.

Two adjustments it makes that a hand-rolled comparison misses: files a commit **added** are
excluded, because they did not exist when the task was written and counting them inflates
recall; files it **deleted** cannot be ranked against today's tree at all. Do not reimplement
this with `git show --name-only` and skip them.

### `jev drift [glob]` — auditing consistency

Asks every convention in the config against every file. Catches drift that grep cannot,
because grep only finds what you already thought to look for.

One call per file, ~250ms for 2KB and ~950ms for 18KB, and the number of questions barely
affects cost or latency — output tokens are free and questions are evaluated in parallel.
**So ask everything you care about in one pass.** Ten conventions cost about what one does.

Probabilities are calibrated enough to read as magnitude, not just as a threshold. In
validation, a file importing a UI library two different ways scored 0.62 while a single-style file
scored 0.97 — the middling value was the correct description of a mixed state, not
indecision. Treat a 0.4–0.7 result as "partially true" and go look.

### `jev gate [ref]` — before committing

Judges a staged diff (or a given ref) against the config's gates. Exits 1 on any flag so it
can hook into pre-commit.

Measured on four real commits: a decryption feature flagged `auth_or_crypto` at 0.99, a
double-submit fix flagged `silent_catch` at 0.91, a CSS tweak and a comment-only change
passed clean (all ≤0.64 and ≤0.03). 745–1770ms per diff, so it fits in a commit hook
without being felt.

This catches a class nothing else in a typical toolchain does: `tsc`, ESLint, and unit tests
all pass a change that quietly touches decryption or drops user input.

## Reading the output

Flags are prompts for a human look, never verdicts. Two failure modes matter more than
false positives:

**Correct but not actionable.** In validation, `silent_catch` fired at 0.91 on a `catch {}`
that was deliberate and had a comment explaining why the failure was safe. The judgment was
literally right and useless. The fix is in the criteria, not the threshold — the config's
`ok` text for that gate now ends with "OR the catch is accompanied by a comment explaining
why the failure is safe to ignore." Same story for hardcoded copy firing on mock chart data,
fixed by excluding fixtures in the `ok` text and `exemptions`.

Tune for this early. An audit that cries wolf gets ignored, and an ignored gate is worse
than no gate — it costs money and buys a false sense of coverage.

**Typed output guarantees shape, not correctness.** A confident number can be confidently
wrong. Run `jev validate` before trusting `rerank` on a new repo, and check a convention or
gate against files whose answer you verified by hand. Without that step you are reading
probabilities you cannot calibrate.

## Why the config is per-project

The flow transfers across repos. The questions do not. Every convention needs its own
exemptions, and the same question needs different phrasing in different codebases — the
`hardcoded_copy` criteria that works in an i18next app is wrong in an app with no i18n at
all. Keep `jev.config.json` in the repo it describes and tune it there.

The validation step is per-project too, which is what `jev validate` is for: a repo with a
meaningful commit history carries its own ground truth. A shallow clone or a squashed history
gives it nothing to work with, and there you are guessing at recall.

## When not to use this

- **One-off judgments where you are the one waiting.** If there are three options and you
  are reading them, decide. A round trip adds latency and no information.
- **Judging candidates you just generated.** If the state and the options both come from the
  agent, the probability measures the agent's own self-consistency, not an outside opinion.
  It will look like validation and will not be.
- **Anything a compiler, type checker, or test can decide.** Those are cheaper, faster, and
  actually authoritative. Use Jev for what they structurally cannot see.
