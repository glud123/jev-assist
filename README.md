# jev-assist

[![skills.sh installs](https://skills.sh/b/glud123/jev-assist)](https://skills.sh/glud123/jev-assist) [![CI](https://github.com/glud123/jev-assist/actions/workflows/ci.yml/badge.svg)](https://github.com/glud123/jev-assist/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/jev-assist)](https://www.npmjs.com/package/jev-assist)

[中文](README.zh-CN.md)

A search comes back as hundreds of lines: too many to read, too risky to guess at. Pipe the
candidates in — raw `grep -rn`, `git ls-files`, a test run, no reformatting — and each one
comes back with a calibrated number, sorted, with an exact total and a cut line. The reply is
~30 rows whether the pool was 40 or 4,000. Built on the three typed judgments of
[TypeSafe Jev](https://docs.typesafe.ai): `noul` (is this hit real?), `choice` (what is it?),
`score` (how bad is it?).

Search tells you where a hit is; this tells you what each hit *is*. Finding things stays with
`grep`/`rg`/`Glob` — nothing here searches, by design.

## Example

```sh
$ grep -rn "getUser" src/ | jev noul 'this line calls the user API in production code, not a test, mock, or comment'
jev noul · 4 candidate(s) · 1 call(s) · 1046ms · 459 input tok · 0/4 cache hit(s)
  "this line calls the user API in production code, not a test, mock, or comment"
  yes 2 / 4 at p >= 0.70
  --- cut: read above (2 row(s); p >= 0.70; 2 below) ---
0.72	"src/api/user.ts:12:  const user = await getUser(id);"
0.70	"src/hooks/useAuth.ts:22:  return getUser(session.token);"
```

Read above the cut — that is the answer. Every number in the banner covers the full pool;
nothing is capped.

## Install

Requires Node 18+ and a [TypeSafe](https://docs.typesafe.ai) or
[OpenRouter](https://openrouter.ai) API key.

### Agent install

**Upgrading from before 1.0.0:** older releases shipped hooks and config files that are gone
now. Give your agent this prompt, then reinstall:

```text
Completely delete the jev-assist skill, including any hooks, config files, and other artifacts left by the old version.
```

Current versions write only three things: the skill directory, the key file, and the cache.

**Use it right now** — paste this prompt to your coding agent:

```text
Run `npx skills use "https://github.com/glud123/jev-assist" --skill "jev-assist"` and follow the generated skill instructions now. Read its complete output, redirecting it to a temporary file first if necessary. Resolve relative paths from the supporting-files directory it provides.
```

**Or install the skill** so your agent has it in every session:

```sh
npx skills add https://github.com/glud123/jev-assist --skill jev-assist
```

Skill-only installs do not put `jev` on PATH — call the script by absolute path
(`node /path/to/jev-assist/scripts/jev.mjs …`).

### Manual install

For your own terminal:

```sh
npm i -g jev-assist   # or call scripts/jev.mjs directly by path
```

### API key

Configure it once, outside any repo:

```sh
jev key sk-or-v1-...   # skill-only install: node /path/to/jev-assist/scripts/jev.mjs key sk-or-v1-...
```

The key lands in `~/.config/jev/key` (0600); a `JEV_API_KEY` environment variable wins. Keys
prefixed `sk-or-` route via OpenRouter, everything else goes straight to TypeSafe
(`JEV_API_URL`/`JEV_MODEL` override). Never put a key in a tracked file.

Using jev as a skill with no key set? The first judgment call fails in milliseconds with the
exact fix — and that is when the agent stops and asks you for a key. No pre-flight, no
per-project config: the question is the interface.

## Usage

One shape, three judgments — the subcommand picks the type of the number:

```sh
# which of these hits is the real thing (0–1 per line)
grep -rn "getUser" src/ | jev noul 'this line calls the user API in production code, not a test, mock, or comment'

# which layer each file belongs to (a label per file)
git ls-files 'src/**' | jev choice 'what layer does this file belong to?' \
  --opt api:"HTTP handler or route" --opt db:"schema, migration, or query" --opt ui:"component or view"

# how severe each TODO is (a rubric level per line)
grep -rn "TODO\|FIXME" src/ | jev score 'is this TODO still valid?' \
  --level 0:"stale, the code moved on" --level 1:"valid, minor" --level 2:"valid and blocking a known bug"
```

Flags: `--top N` (fix the cut), `--by-file N` / `--by-dir N` (census of the selected rows by
path or directory — top N listed, the rest summed exactly), `--json` (every row, uncapped),
`--fresh` (re-judge; verdicts still merge into the cache). Any error exits 1 — a failed call
never prints a count that looks like zero.

For agent-facing routing rules, question phrasing, and measured failure modes, see
[SKILL.md](SKILL.md).

## Privacy

Each call sends the candidate lines, the question, and the API key to the Jev endpoint.
Verdicts are cached in `~/.cache/jev/cache.json`, keyed by question+line — jev is
self-consistent by design, so a cached verdict is the verdict; `--fresh` recomputes. If the
repo must not leave the machine, do not point jev at it.

## Uninstall

Delete the skill directory, then `rm -f ~/.config/jev/key` (it is a credential — deleting it
is the point) and `rm -rf ~/.cache/jev`, plus `npm unlink -g jev-assist` if `which jev`
resolves. Nothing else was ever written: no config, no hooks, nothing in any repo.

## Not for

Retrieval; pools small enough to read; anything a compiler, linter, or test decides; judging
candidates you just generated yourself.

MIT — see [LICENSE](LICENSE).
