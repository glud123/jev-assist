# jev-assist

Typed judgments over a codebase, using [TypeSafe Jev](https://docs.typesafe.ai). Judgments
worth making a few hundred times and pointless to make once — plus a way to check whether
they hold on your repo:

| Command | Question it answers | Cost |
| --- | --- | --- |
| `jev rerank "<task>"` | Which files matter for this task? | 1 call / 60 files |
| `jev validate [n]` | Is rerank accurate enough **on my repo**? | n × rerank |
| `jev drift [glob]` | Which files drifted from our conventions? | 1 call / file |
| `jev gate [ref]` | Does this diff touch something dangerous? | 1 call / diff |

Jev returns typed answers with probabilities instead of text. Output tokens are free and
questions in one call are evaluated in parallel, so asking ten questions costs about what
asking one does — which is what makes whole-repo passes practical.

## Install

As an agent skill, into the repo you want to judge:

```sh
npx skills add glud123/jev-assist
export JEV_API_KEY=...        # from typesafe.ai
```

Your agent then reads `SKILL.md` and calls the script by path. To also get a `jev` command in
your own shell:

```sh
git clone https://github.com/glud123/jev-assist && cd jev-assist && npm link
```

Node 18+ (uses built-in `fetch`). No dependencies.

## Use

```sh
cd /path/to/your/repo
cp .claude/skills/jev-assist/jev.config.example.json jev.config.json   # then edit
jev validate 20                                                   # start here: is it accurate?
jev rerank "add CSV export to the orders table"
jev drift 'src/**/*.tsx'
jev gate                                                          # staged changes
jev gate HEAD~1                                                   # a past commit
```

Pre-commit hook:

```sh
echo 'jev gate || exit 1' >> .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

## Configure

`jev.config.json` lives in the repo being judged, not here. Conventions and gates are
project-specific: the phrasing that works in an i18next app is wrong in an app without i18n.

```jsonc
{
  "conventions": {
    "hardcoded_copy": {
      "ask": "Does this file contain user-visible UI text inline instead of i18next keys?",
      "drift": "has hardcoded user-visible copy",
      "ok": "all copy is translated. Mock data and fixtures do not count."   // ← exclusions go here
    }
  },
  "gates": { /* same shape, asked against a diff */ },
  "exemptions": { "hardcoded_copy": ["/mocks/", ".test."] }                  // ← path substrings
}
```

Tuning happens in the `ok` text. Most noise is a judgment that is literally correct but not
actionable — a deliberate `catch {}`, copy in mock data — and the fix is to say so in `ok`,
not to raise the threshold.

## Validate before trusting

Typed output guarantees the shape of an answer, not its correctness. Accuracy does not
transfer between repos, so the numbers below are ours, not yours. Get yours:

```sh
jev validate 20
```

Ground truth comes from git, free: a commit message is a task, the files that commit changed
are the answer. `validate` replays the last n commits, ranks the whole repo against each
subject line, and prints recall at each cutoff.

```
  #  task                                    truth   @20   @40
  1  fix avatar upload failing on Safari              7     5     6
  2  add CSV export to the orders table          4     4     4
  3  bump deps and fix lint                     12     2     3

  recall@20 0.48   recall@40 0.57   (23 files over 3 commits)
  worst: "bump deps and fix lint" — 2/12
```

Read the last line as much as the first: dependency bumps and sweeping renames have no
semantic signal and will always score low. That tells you which tasks to use `rerank` for.

Two things `validate` handles that a hand-rolled comparison gets wrong. Files a commit
**added** are excluded — they did not exist when the task was written, so counting them
inflates recall. Files it **deleted** are gone from today's tree and cannot be ranked at all.

Measured this way on one private 705-file React app:

- **rerank** — recall@20 5/7, recall@40 6/7. Best case: `src/services/upload.ts` ranked 6th
  for an image-upload task in an unrelated feature, a cross-layer file grep would have missed. Worst case: a file
  changed only by reference landed at 121/705.
- **gate** — 0.99 on a decryption feature, 0.91 on a swallowed error, ≤0.64 on a CSS tweak,
  ≤0.03 on a comment-only change. 745–1770ms per diff.
- **drift** — 0.97 and 0.62 on two files importing a UI library inconsistently, where 0.62 correctly
  described a file mixing both import styles. 231–953ms per file.

Run `validate` before trusting `drift` or `gate` on a new repo too. It only scores `rerank`,
but a repo where `rerank` reads low is one where the config's phrasing needs work first.

## Known limits

- **rerank misses structural coupling.** Files changed only because a reference changed have
  no semantic signal. Follow the imports of the top results.
- **Correct ≠ actionable.** Validation produced a 0.91 `silent_catch` on an intentional empty
  catch that had a comment explaining why it was safe. Budget time for criteria tuning; an
  audit that cries wolf gets ignored.
- **No retry or concurrency control.** Sequential calls, no 429 backoff. Fine to a few
  thousand files; add `p-limit` and exponential backoff beyond that.
- **Do not judge candidates you just generated.** If the state and the options both come from
  one model, the probability measures its self-consistency, not an outside opinion.

## Status

Early. Validated on one repo, three scenarios. The flow generalizes; the configs do not.

## License

MIT
