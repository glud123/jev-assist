# jev-assist

Typed judgments over a codebase, using [TypeSafe Jev](https://docs.typesafe.ai). Three things
that are worth doing a few hundred times and pointless to do once:

| Command | Question it answers | Cost |
| --- | --- | --- |
| `jev rerank "<task>"` | Which files matter for this task? | 1 call / 60 files |
| `jev drift [glob]` | Which files drifted from our conventions? | 1 call / file |
| `jev gate [ref]` | Does this diff touch something dangerous? | 1 call / diff |

Jev returns typed answers with probabilities instead of text. Output tokens are free and
questions in one call are evaluated in parallel, so asking ten questions costs about what
asking one does — which is what makes whole-repo passes practical.

## Install

```sh
git clone <this repo> && cd jev-assist
npm link                      # exposes `jev`; or call scripts/jev.mjs directly
export JEV_API_KEY=...        # from typesafe.ai
```

Node 18+ (uses built-in `fetch`). No dependencies.

## Use

```sh
cd /path/to/your/repo
cp /path/to/jev-assist/jev.config.example.json jev.config.json   # then edit
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

Typed output guarantees the shape of an answer, not its correctness. Calibrate on ground
truth you already have: a commit message is a task, and the files that commit changed are the
answer.

```sh
git log --oneline -20                       # pick a commit
jev rerank "<its message>"                  # then compare against:
git show --name-only --format="" <sha>
```

Measured this way on one private 705-file React app:

- **rerank** — recall@20 5/7, recall@40 6/7. Best case: `src/services/upload.ts` ranked 6th
  for an image-upload task in an unrelated feature, a cross-layer file grep would have missed. Worst case: a file
  changed only by reference landed at 121/705.
- **gate** — 0.99 on a decryption feature, 0.91 on a swallowed error, ≤0.64 on a CSS tweak,
  ≤0.03 on a comment-only change. 745–1770ms per diff.
- **drift** — 0.97 and 0.62 on two files importing a UI library inconsistently, where 0.62 correctly
  described a file mixing both import styles. 231–953ms per file.

Note the leak to avoid when doing this: files *created* by the commit exist in today's tree
but would not have at task time, so they inflate recall. Exclude them.

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
