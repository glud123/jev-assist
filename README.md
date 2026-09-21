# jev-assist

[中文](README.zh-CN.md)

Starting a task in a 600-file repo, perhaps 8 of those files are worth reading. Finding the 8
often costs more than changing them.

Existing approaches have their limits. Grep needs the target expressed as a pattern that matches,
so it reaches only the files naming the feature. Having a model read the whole repo costs time and
tokens in proportion to the file count. Neither suits a judgment that has to be applied at scale —
the same question asked of every file.

jev-assist delegates that class of judgment to [TypeSafe Jev](https://docs.typesafe.ai), which
answers closed questions and returns typed values with probabilities rather than prose. Three
commands follow from it: `rerank` ranks every file by relevance to a task, `drift` checks files
one by one against your team's conventions, and `gate` judges whether a diff about to be committed
touches something dangerous.

The cost structure is what makes this viable: output tokens are free and the questions inside one
call are evaluated in parallel, so asking 10 of them costs about what asking 1 costs. Whole-repo
passes only make financial sense under that pricing.

## Install

**Recommended: let a coding agent do it.** Hand it this prompt, with `<your-key>` replaced:

```
Install the jev-assist skill with npx skills add glud123/jev-assist, then finish the setup
per its SKILL.md: run jev key with the key <your-key>, write a jev.config.json in this
repo's root, and run jev check plus jev validate 20. Show me the results along with which
conventions you inferred from reading code versus which ones you guessed.
```

It has read your code, and `SKILL.md` tells it what to derive from where, so the first draft of
the config comes faster from the agent than from you. Get the key before you send the prompt —
without one the agent stops at the first step, because every command that reaches the API fails
without it.

**Manual install.**

```sh
npx skills add glud123/jev-assist                        # install the skill
jev key sk-...                                           # key → ~/.config/jev/key, 0600, outside the repo
cp <skill-dir>/jev.config.example.json jev.config.json   # then edit it, in the repo being judged
jev check                                                # verify key and config
```

Node 18 or newer, because it uses the built-in `fetch`. Nothing else to install. Any
skills-compatible agent works — Claude Code, Codex and Cursor read the same `SKILL.md` and call
the script by path.

Installing as a skill does not put `jev` on your PATH. If you want the command in your own
shell:

```sh
git clone https://github.com/glud123/jev-assist && cd jev-assist && npm link
```

**Uninstall.** Deleting the skill is not enough — the setup writes a key, a config and possibly a
pre-commit hook, all outside the skill directory, and a hook calling `jev gate` breaks every
commit once the script is gone. Hand an agent this prompt and `SKILL.md` gives it the full list:

```
Uninstall the jev-assist skill following the Uninstall section of its SKILL.md: remove the
pre-commit hook, the stored key, any JEV_ environment variables, the per-repo config and
output, and the skill itself. Show me anything you are unsure about before deleting it.
```

By hand:

```sh
rm -f .git/hooks/pre-commit              # only if `jev gate` is all it contains
rm -f ~/.config/jev/key                  # per machine ($XDG_CONFIG_HOME/jev/key if set)
rm -f jev.config.json .jev-rerank.json   # per judged repo, from its root
grep -rn JEV_ ~/.zshrc ~/.bashrc .env    # a key left in a rc file is still a live key
npm unlink -g jev-assist                 # only if you ran npm link
```

## Using it in an agent session

The point of the skill is that the agent reaches for it when it should. You do not memorize
commands; you state the intent, with the session's working directory set to the repo being
judged.

```
Use jev-assist to find which files this task touches before you start: add CSV export to
the orders table.
```

```
Run jev-assist drift over src/**/*.tsx and rank what it flags by severity.
```

```
Before I commit, use jev-assist to check whether the staged changes touch anything dangerous.
```

The agent calls `scripts/jev.mjs` as described in `SKILL.md` and reads the ranking or the flags
back to you. If it does not reach for the skill on its own, name `jev-assist` in the prompt. On
a repo it has not used this on before, have it run `jev validate 20` first — whether the ranking
is accurate is a measurable fact, not a claim you have to take.

## What it actually does

**`jev rerank "<task>"`** ranks every tracked file against a one-line task description. On a
private React app of 705 files, replaying 10 real commits, the top 20 caught 68% of the files
those commits touched and the top 40 caught 80%. The average is the boring part: every commit
that touched 1 to 4 files scored full marks, while the one that touched 11 got 5 of them. So
read the top 20 as the core of a change but never as the whole of it — past the cutoff the
ranking is no longer reliable, and following the imports of the top results beats reading further
down.

Where it beats grep is files that never mention the feature at all. A shared upload service
came back 6th for an image-upload task in a completely unrelated corner of the app. Nobody
searching `avatar` or `profile` was going to find that.

**`jev drift [glob]`** asks your conventions against your files, one call per file. The number
of questions barely moves the cost, so ask ten things at once instead of one: untranslated copy,
code that routes around the request wrapper you wrote for exactly this purpose, server state
living outside the store. The difference from grep is the input: grep needs you to express the
violation as a pattern that matches, while here you write down the convention itself and leave
judging what breaks it to the model.

**`jev gate [ref]`** reads a staged diff and flags risk. It exits nonzero on a hit, so a
pre-commit hook needs nothing but the bare command. Measured on four real commits: a decryption
feature came back 0.99, a fix for a swallowed error 0.91, a CSS tweak 0.64, a comment-only
change 0.03. Somewhere between 0.7 and 1.8 seconds per diff. Your typechecker, your linter and
your unit tests will all wave through a change that quietly drops user input, which is the
entire reason this command exists.

**`jev validate [n]`** is the one to run first and the one everybody skips. It replays your own
commits as tasks and grades the ranking against what each commit really changed. Accuracy does
not survive the trip between two codebases, so the numbers above are ours. Your git history is
free labelled data, already sitting there.

## Commands

```sh
cd /path/to/your/repo
jev check                                    # key + config, before anything else
jev validate 20                              # start here: is it accurate?
jev rerank "add CSV export to the orders table"
jev drift 'src/**/*.tsx'
jev gate                                     # staged changes
jev gate HEAD~1                              # a past commit
```

| Command | Question it answers | Cost |
| --- | --- | --- |
| `jev rerank "<task>" [--json]` | Which files matter for this task? | 1 call / `batchSize` files (default 60) |
| `jev validate [n]` | Is rerank accurate enough **on my repo**? | n × rerank |
| `jev drift [glob]` | Which files drifted from our conventions? | 1 call / file |
| `jev gate [ref]` | Does this diff touch something dangerous? | 1 call / diff |
| `jev check` | Is my key and config well-formed? | free, no network |
| `jev key <k>` | Store an API key outside the repo | free, no network |

`rerank` prints the top N and nothing else. Pass `--json` when something needs to read past the
cutoff and it also writes the full ranking to `.jev-rerank.json` in the repo root; add that file
to `.gitignore`.

Read the printed list by the scores, not by the row count. `topN` is a fixed number of rows, not a
filter — a task that genuinely touches 3 files still prints 20, and the bottom 17 are merely the
least unrelated files in the repo.

Scores are levels, not probabilities: 0 to 3, where 3 is "likely must be read or edited", 2 is
"shows the existing pattern to follow", 1 is background and 0 is unrelated. Read everything at 2.5
or above. Cut at a gap below that if there is one, but do not wait for a gap — a top 20 spanning
half a point means nothing stood out, not that all 20 are candidates.

### Wiring up pre-commit

One line for an agent:

```
Wire jev gate into this repo's pre-commit hook. If a hook already exists, append a line
instead of overwriting it.
```

By hand:

```sh
h=.git/hooks/pre-commit
[ -e "$h" ] && echo "$h exists — add a 'jev gate' line to it yourself" ||
  { printf '#!/bin/sh\njev gate\n' > "$h" && chmod +x "$h"; }
```

It writes a hook containing just `jev gate` and marks it executable when there is no hook, and
only prints a note when one already exists — which it will if Husky or pre-commit is installed.

## Configure

The config is per project: `jev.config.json` lives in the root of the repo being judged, one per
repo, never shared and never in the jev-assist repo itself. The reason is that the phrasing of a
question depends on the codebase — wording that catches untranslated copy in an i18next app is
not even meaningful in an app with no i18n, where it would flag every file.

```jsonc
{
  "description": "A React admin dashboard built with TanStack Query and i18next.",
  "include": ["src/**/*.ts", "src/**/*.tsx"],

  "conventions": {
    "hardcoded_copy": {
      "ask": "Does this file contain user-visible UI text inline instead of i18next keys?",
      "drift": "has hardcoded user-visible copy",
      "ok": "all copy is translated, or the file has no UI text. Mock data and fixtures do not count."
    }
  },

  "gates": {
    "data_loss": {
      "ask": "Could this change lose or silently discard user-entered data?",
      "risk": "a realistic path exists where user input is lost",
      "ok": "user data is preserved on every path"
    }
  },

  "exemptions": {
    "hardcoded_copy": ["/mocks/", ".test."]
  },

  "batchSize": 60,
  "topN": 20,
  "threshold": 0.7,
  "validateK": [20, 40]
}
```

Top-level fields:

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `description` | yes | — | One line on what the app is and what it is built with. Every question carries it as context, so name the libraries the conventions below refer to |
| `include` | yes | — | Globs defining the file pool for `rerank` and `drift`; only git-tracked files are considered. Confirm it matches something with `git ls-files '<glob>' \| wc -l` |
| `conventions` | no | — | The rules `drift` checks. Keys are yours to name. Only rules this codebase actually follows |
| `gates` | no | — | The risks `gate` checks. Same shape as `conventions`, asked against a diff |
| `exemptions` | no | — | Per convention, a list of path substrings; a file whose path contains one skips that check |
| `batchSize` | no | `60` | Files scored per `rerank` call |
| `topN` | no | `20` | Rows `rerank` prints. A fixed count, not a relevance filter |
| `threshold` | no | `0.7` | Probability at or above which something counts as a hit, shared by `drift` and `gate` |
| `validateK` | no | `[20, 40]` | Cutoffs `validate` computes recall at |

Inside each entry of `conventions` and `gates`:

| Field | Meaning |
| --- | --- |
| `ask` | The closed question put to the model. Anchor it to the concrete module ("the request wrapper in `src/services`"), never to a principle |
| `drift` / `risk` | The line printed on a hit. `conventions` use `drift`, `gates` use `risk` |
| `ok` | What counts as passing. Exclusions go here; this is the main place you tune |

`jev check` rejects a config missing `description` or `include`, and also catches the mechanical
faults — placeholders left in, empty groups, an exemption naming a convention that does not
exist. What it cannot do is read your code, so it cannot tell whether a question holds in this
repo at all: a convention asking about a shared request wrapper you never had passes check and
then flags every file. Ask the agent which conventions it found by reading code and which ones it
guessed at — the guesses are where the problems are.

Tuning happens in the `ok` text. Nearly all the noise you will see is a judgment that is
literally correct and not worth acting on — a deliberate `catch {}`, copy inside mock chart
data. Say so in `ok`. Raising `threshold` does not help: the noise scores high too — that
deliberate `catch {}` came back at 0.91 — so a bar at 0.95 keeps it and drops the genuine
findings sitting between 0.75 and 0.9 instead.

### Key and endpoint

`jev key <API_KEY>` writes the key to `~/.config/jev/key` at mode 0600 — or to
`$XDG_CONFIG_HOME/jev/key` when that variable is set. Never in the repo.

The endpoint is derived from the key's prefix, since both providers take the same request body:

| Key prefix | Provider | Endpoint | Model |
| --- | --- | --- | --- |
| `sk-or-…` | OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` |
| anything else | TypeSafe direct | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |

Three environment variables override that:

| Variable | Effect |
| --- | --- |
| `JEV_API_KEY` | The key to use. Takes precedence over the stored file, which is then not read |
| `JEV_API_URL` | The endpoint to call, replacing the prefix-derived one. Use for a self-hosted gateway |
| `JEV_MODEL` | The model to request, replacing the prefix-derived one. Use to pin a version |

The two URL/model variables are independent: set `JEV_MODEL` alone and the endpoint still comes
from the key prefix. `jev check` prints the key masked along with the provider, endpoint and model
actually in play — worth reading before debugging a call, since a key sent to the wrong provider
comes back as a plain 401.

## Validate before trusting

Typed output guarantees the shape of an answer. Nothing about the answer.

```sh
jev validate 20
```

A commit subject is a task and the files that commit changed are the answer. `validate` walks
back through non-merge commits until it has n that touched something inside `include`, ranks the
whole repo against each subject line, and prints recall at each cutoff.

```
  #  task                                 truth   @20   @40
  1  fix avatar upload failing on Safari      7     5     6
  2  add CSV export to the orders table       4     4     4
  3  bump deps and fix lint                  12     2     3

  recall@20 0.48   recall@40 0.57   (23 files over 3 commits)
  worst: "bump deps and fix lint" — 2/12
```

That last line deserves as much attention as the first. Dependency bumps and sweeping renames
carry no semantic signal and will always score badly, which is a fact about the task rather than
a defect in the tool. It tells you when to skip `rerank` and just grep.

Two adjustments a hand-rolled comparison gets wrong, if you were thinking of writing this
yourself with `git show --name-only`. Files a commit **added** are excluded, since they did not
exist when the task was written and counting them inflates recall. Files it **deleted** are gone
from today's tree and cannot be ranked at all. Commits that touched nothing rankable get skipped
rather than scored as zero, so `validate 20` may look further back than twenty commits.

Run it before trusting `drift` or `gate` on a new repo too. It only grades `rerank`, but a repo
where `rerank` reads low is a repo where the config's phrasing needs work first.

## Known limits

- **rerank cannot see structural coupling.** A file that changed only because something it
  imports changed has no semantic signal, and one such file landed at 121 out of 705. Follow
  the imports of the top results.
- **Correct is not the same as actionable.** Validation turned up a 0.91 `silent_catch` on an
  intentional empty catch that had a comment above it explaining why the failure was safe.
  Budget time for tuning criteria. An audit that cries wolf gets muted, and a muted gate costs
  money while buying a false sense of coverage.
- **No retry, no concurrency control.** Sequential calls, no 429 backoff. Fine up to a few
  thousand files. Past that, add `p-limit` and exponential backoff.
- **Do not judge candidates you just generated.** If the state and the options both come out of
  one model, the probability measures its self-consistency and nothing else. It will look like
  validation.

## License

MIT
