---
name: verify
description: Verify pstack's Claude Code build as a user meets it, by running tools/verify.mjs and reading its evidence table. Use before declaring done on any change under plugins/pstack, .claude-plugin, VERSION, tools/verify or .claude, and when asked to verify, test the plugin, or check that it still loads.
---

# Verify the Claude Code build

`tools/verify.mjs` starts the real `claude` CLI against a snapshot of the tree you would commit, then recomputes every verdict from the saved traces. Setup, driver and checker are three modules (`tools/verify/setup.mjs`, `drive.mjs`, `check.mjs`) so none vouches for itself. The surface tier makes no model call and costs $0.

## Run

```shell
bun tools/verify.mjs --tier surface
bun tools/verify.mjs --flow S3
```

It needs `bun` and a `claude` on PATH. Run it from the worktree root. The first line printed is the verdict, then the evidence table.

```text
PASS surface 2/2 | behavior NOT BUILT | round 1
| S2 the plugin loads from the tree | pass | no plugin_errors; 44 skills in the tree, each in init.skills; ...
```

## Read the evidence

Each row is one check. `pass` and `fail` are what they say. `unobservable` means the trace lacks the event the check needs, and `error` means the check could not be judged. Both count as `fail`. A failed row lists each failed assertion with what it saw and what it wanted: read that, not the verdict word.

The run directory is `<git dir>/pstack-verify/runs/<run>/` and holds `evidence.md`, `evidence.json`, `receipt.json` and the raw traces. It lives in the git directory, never under the working tree, and the last five runs are kept. `bun tools/verify.mjs check <run dir>` reruns the checker alone; its line starts with `RECHECK`. `receipt.json` has no authority: anything that gates reruns the verifier.

## Verdicts

| Verdict | Meaning | What you do |
| --- | --- | --- |
| PASS | Every check passed against the `claude` on PATH. | Paste the table into the PR. |
| FAIL | A check failed, was unobservable, or could not be judged. | Fix the product, rerun. |
| PARTIAL | Nothing failed, but `--tier` or `--flow` left a check out. | Not done. Run the full set. |
| STAND-IN | Nothing failed against a CLI that is not Claude Code, or one named by `PSTACK_VERIFY_CLAUDE`. | Not done. It says nothing about the `claude` a user has. |
| SKIPPED | No `claude` on PATH, nothing ran. | Not done. Install it, or report BLOCKED. |
| BLOCKED | Not printed by the tool. You report it: the run cannot happen or cannot pass for a reason outside the change, or three rounds failed. | Stop and say so, with the table of the last run. |

Only PASS counts. A PASS on a partial run is PARTIAL, never PASS.

## Rules for the builder

- On FAIL fix the product, never the check. Do not weaken, skip or delete an assertion to get green.
- A change never edits the judge and the product together. The judge is `tools/verify.mjs`, `tools/verify/` with its flows and checks, `tests/verify/`, `.claude/settings.json` and the behavior workflows. The product is `plugins/pstack`, `.claude-plugin` and `VERSION`. Both lists are `JUDGE` and `PRODUCT` in `tools/verify/paths.mjs`. If a check is wrong, change it in its own pull request.
- Stop and report after three failed rounds. The round count is in the first line.
- Assert on structured events, never on what the model said.

## Feature map

`tools/verify/feature-map.json` maps path globs of the Claude Code build to the check ids that cover them, and lists what is uncovered, with a reason. Before you change a path, look it up:

- Covered: run the named checks, and expect them to fail if you break the feature.
- Uncovered: the verifier cannot see a regression there. Say so in the PR and test it another way.

`tests/verify/feature-map.test.mjs` fails when a watched path matches no entry, when an entry names a check that does not exist, and when a glob matches nothing. Adding a check means a flow file, a check file and a map entry.

## Escaped bugs

A bug that reached a release gets an entry in `tools/verify/escapes.json` in the same pull request as its fix. The entry names the check or test that now fails on it. See CONTRIBUTING.md.
