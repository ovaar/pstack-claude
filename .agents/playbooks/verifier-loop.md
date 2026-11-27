---
extends: feature, bug-fix, refactoring, authoring-a-skill, opening-a-pr
when: Any change to plugins/pstack, .claude-plugin, VERSION, .claude, .agents/playbooks, tools/verify or the behavior workflows.
---

# Verifier loop

This repository has a verifier for the Claude Code build. Read `.claude/skills/verify/SKILL.md` for how to run it and what each verdict means. A change is not done until the verifier has passed against the tree you are about to commit.

- **After** "Verify on the matching surface." Run `bun tools/verify.mjs` from the worktree root, using a subagent that wrote none of the change when your runtime can start one, and read its evidence table. Only PASS counts. Look the paths you changed up in `tools/verify/feature-map.json`, and for a path the map lists as uncovered, verify it another way and say so.
- **After** "Verify on the same surface." Run `bun tools/verify.mjs` and read the table. The original repro passing is not enough: PASS must hold for the whole run. On FAIL, fix the product, not the check. A fix never edits `tools/verify/checks`, `tools/verify/flows` or `tests/verify` in the same change as product code. Stop and report after three failed rounds, with the last table.
- **After** "Prove behavior is unchanged on the real artifact" Run `bun tools/verify.mjs`. A refactor that turns it from PASS to FAIL changed behavior: fix the product, not the check. Stop and report after three failed rounds.
- **After** "Validate the skill" Run `bun tools/verify.mjs`, because a skill edit can drop the skill from the session. On FAIL, fix the skill, not the check. Stop and report after three failed rounds.
- **In** "`## Verification`" paste the first line and the verdict table of `evidence.md` into the pull request's Test run section. This repository's template calls it Test run. A PARTIAL, STAND-IN or SKIPPED verdict goes in as it is, with the reason the full run did not happen.

Three rounds failed, or the verifier cannot run for a reason outside the change: stop. Report BLOCKED with the last table, and do not mark the work done.
