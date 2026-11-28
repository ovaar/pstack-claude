---
extends: feature, bug-fix, refactoring, authoring-a-skill, opening-a-pr
when: Any change to plugins/pstack, .claude-plugin, VERSION, .claude, .agents/playbooks, tools/verify or the behavior workflows.
---

# Verifier loop

This repository has a verifier for the Claude Code build. Read `.claude/skills/verify/SKILL.md` for how to run it and what each verdict means, and `docs/verifier.md` for the whole loop. A change is not done until the verifier has passed against the tree you are about to commit.

"Passed" means `bun tools/verify.mjs --tier surface` printed `PASS`, or `PARTIAL` with `surface n/n` and every other tier `NOT RUN` or `NOT BUILT`, which is what a surface-only run prints and what the push gate accepts. When the change touches the mandate (`plugins/pstack/hooks/session-start-context.md`, `session-start.sh`, `hooks.json`) or skill routing (a skill's `name`, `description` or `user-invocable`, or `poteto-mode`, `why`, `how`), also run `bun tools/verify.mjs --tier all`, which must print `PASS`.

- **After** "Verify on the matching surface." Run `bun tools/verify.mjs --tier surface` from the worktree root, using a subagent that wrote none of the change when your runtime can start one, and read its evidence table. Only a passing verdict, as above, counts. Look the paths you changed up in `tools/verify/feature-map.json`, and for a path the map lists as uncovered, verify it another way and say so.
- **After** "Verify on the same surface." Run `bun tools/verify.mjs --tier surface` and read the table. The original repro passing is not enough: every check of the run must pass. On FAIL, fix the product, not the check. A fix never edits `tools/verify/checks`, `tools/verify/flows` or `tests/verify` in the same change as product code. Stop and report after three failed rounds, with the last table.
- **After** "Prove behavior is unchanged on the real artifact" Run `bun tools/verify.mjs --tier surface`. A refactor that turns it from passing to FAIL changed behavior: fix the product, not the check. Stop and report after three failed rounds.
- **After** "Validate the skill" Run `bun tools/verify.mjs --tier all`, because a skill edit can drop the skill from the session or change where the mandate routes. On FAIL, fix the skill, not the check. Stop and report after three failed rounds.
- **In** "`## Verification`" paste the first line and the verdict table of `evidence.md` into the pull request's Test run section. This repository's template calls it Test run. A PARTIAL, STAND-IN or SKIPPED verdict goes in as it is, with the reason the full run did not happen.

Three rounds failed, or the verifier cannot run for a reason outside the change: stop. Report BLOCKED with the last table, and do not mark the work done.
