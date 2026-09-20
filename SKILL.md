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

Needs `JEV_API_KEY` in the environment and a `jev.config.json` in the repo root
(copy `jev.config.example.json`). Conventions and gates are per-project on purpose —
see "Why the config is per-project" below.

## The commands

### `jev rerank "<task>"` — before writing code

Scores every tracked file for relevance to a task, prints the top N. Use at the start of
work in a repo you do not know by heart, to find the files worth reading.

Measured on a 705-file React app, task taken from a real commit message, ground truth from
what that commit actually changed: **recall@20 5/7, recall@40 6/7**. One call per 60 files,
~16s and ~93k input tokens for the full repo.

It earns its keep on files that share no keyword with the task. In that test,
`src/services/upload.ts` ranked 6th for an image-upload task in an unrelated feature — a
cross-layer file that grep on either `questionnaire` or `upload` would have missed or buried.

**Where it fails:** files changed only because a reference changed rank low (one ground-truth
file landed at 121/705). Semantic scoring cannot see structural coupling. Always follow the
imports of the top results before assuming the list is complete.

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
