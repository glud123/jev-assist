# jev-assist

[![skills.sh installs](https://skills.sh/b/glud123/jev-assist)](https://skills.sh/glud123/jev-assist) [![CI](https://github.com/glud123/jev-assist/actions/workflows/ci.yml/badge.svg)](https://github.com/glud123/jev-assist/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/jev-assist)](https://www.npmjs.com/package/jev-assist)    [中文](README.zh-CN.md)

One calibrated number per candidate, for a coding agent's floods. Pipe any search's output in
— raw `grep -rn`, `git ls-files`, a test run, no reformatting — and get a sorted list back
with a cut line and an exact total: the same ~30 rows whether the pool was 40 or 4,000. Built
on the three typed judgments of [TypeSafe Jev](https://docs.typesafe.ai): `noul` (is this hit
real?), `choice` (what is it?), `score` (how bad is it?).

Search says where a hit is. This decides what each hit *is*. Finding things stays with
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

Read above the cut; that is the answer. Every number in the banner is over the full pool,
never a cap.

## Install

Requires Node 18+ and a [TypeSafe](https://docs.typesafe.ai) or
[OpenRouter](https://openrouter.ai) API key.

**Upgrading from a version before 1.0.0:** older releases shipped hooks and config files that
no longer exist. Give your agent this prompt, then reinstall fresh:

```text
Completely delete the jev-assist skill, including any hooks, config files, and other artifacts left by the old version.
```

Current versions write nothing but the skill directory, the key file, and the cache.

**Let your agent use it right now** — paste this as a prompt to your coding agent:

```text
Run `npx skills use "https://github.com/glud123/jev-assist" --skill "jev-assist"` and follow the generated skill instructions now. Read its complete output, redirecting it to a temporary file first if necessary. Resolve relative paths from the supporting-files directory it provides.
```

**Install the skill** so it is available to your agent in every session:

```sh
npx skills add https://github.com/glud123/jev-assist --skill jev-assist
```

**Or install the CLI globally** if you want `jev` on your own PATH:

```sh
npm i -g jev-assist   # or call scripts/jev.mjs directly by path
```

Installed as a skill only, `jev` is not on PATH — call the script by absolute path
(`node /path/to/jev-assist/scripts/jev.mjs …`).

### API key

Store it once, outside the repo:

```sh
jev key sk-or-v1-...   # skill-only install: node /path/to/jev-assist/scripts/jev.mjs key sk-or-v1-...
```

The key lands in `~/.config/jev/key` at 0600; `JEV_API_KEY` in the environment wins. Keys
with the `sk-or-` prefix route via OpenRouter, everything else to TypeSafe directly
(`JEV_API_URL`/`JEV_MODEL` override). Never write a key into a tracked file.

If you use jev as a skill and no key is set, the agent stops and asks you for one at the
first judgment call — a missing key fails in milliseconds with the exact command to run, and
that is when the agent asks. No key pre-flight, no per-project config: the question is the
interface.

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
path or directory — top N, rest summed exactly), `--json` (every row, uncapped), `--fresh`
(re-judge; verdicts still merge into the cache). Exit 1 on any error — a failed call never
prints a count that looks like zero.

For the agent-facing routing rules, question-phrasing guidance, and measured failure modes,
read [SKILL.md](SKILL.md).

## Privacy

Each call sends the candidate lines, the question, and the API key to the Jev endpoint.
Verdicts are cached in `~/.cache/jev/cache.json` keyed by question+line — jev is
self-consistent by design, so a cached verdict is the verdict; `--fresh` recomputes. If the
repo must not leave the machine, do not point jev at it.

## Uninstall

Delete the skill directory, then: `rm -f ~/.config/jev/key` (a credential — deleting it is
the point), `rm -rf ~/.cache/jev`, and `npm unlink -g jev-assist` if `which jev` resolves.
Nothing else was written: no config, no hooks, nothing in any repo.

## Not for

Retrieval; pools small enough to read; anything a compiler, linter, or test decides; judging
candidates you generated yourself.

MIT — see [LICENSE](LICENSE).
