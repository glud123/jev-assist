<EXTREMELY_IMPORTANT>
The `jev-assist` skill is installed. It answers closed questions about a codebase by
applying one judgment to every file in a pool too large to read — in any language.

**Before your first search of a codebase you have not read, you MUST invoke it** if the
question asks which files share a property no single pattern can match: what still does X,
what has not been migrated to Y, what breaks an unwritten convention, where a change would
land, whether a staged diff is safe to commit.

If you think there is even a 1% chance it applies, invoke it. If it turns out wrong for the
situation, you don't have to use it — but decide that after reading it, not before.

These thoughts mean STOP — you are about to hand-code a judgment as a pattern:

| Thought | Reality |
|---|---|
| "Let me grep first and see what comes back" | Grepping is right — the skill opens by telling you to. What it decides is what you do when a flood comes back, and it costs one call to know that now instead of five patterns later. Invoke it, then grep. |
| "Let me just `ls` and read the config to get oriented" | That is already the first search. Orienting does not answer the question, and by the time it ends you are mid-investigation with momentum. Invoke first, orient second. |
| "I'll just narrow this with a few more exclusions" | An exclusion that needs to know what a file *is* or what a match *means* is a judgment. That is the skill's job. |
| "I can tell the real hits from the noise by the path" | A path is a proxy. Per-file judgment is what `drift` does. |
| "This codebase might be small enough to read" | You cannot know that before exploring, and once you explore you are already on the grep path. Check first. |
| "The question is vague, so grep is the only option" | Vague + no literal to search is exactly `rerank`. |

User instructions and CLAUDE.md take precedence. Only skip this when your human partner has
told you to.
</EXTREMELY_IMPORTANT>
