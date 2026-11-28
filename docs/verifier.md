# The verifier

Read this first. It covers the Claude Code build only: `plugins/pstack`, `.claude-plugin` and `VERSION`, loaded the way a Claude Code user loads them. The other runtimes have their own tests in [CONTRIBUTING.md](../CONTRIBUTING.md).

## The loop

A change to the product is made against `bun tools/verify.mjs`, and its author never judges it. Each run has three roles in three modules, and none can vouch for itself:

| Role | Module | Does |
| --- | --- | --- |
| Setup | `tools/verify/setup.mjs` | Snapshots the tree you would commit into a stage, and builds a clean environment around it: throwaway home, config directory and working directory, every inherited Claude and pstack variable removed. |
| Driver | `tools/verify/drive.mjs` | The only code that starts the real `claude` CLI against the stage. It saves raw traces and judges nothing. |
| Checker | `tools/verify/check.mjs` | Recomputes every verdict from the traces' structured events, never from what a model wrote and never from an exit code. It also confirms the driver did not cheat: the plugin path is the stage, a surface run cost nothing, a model run called a model, the stage did not move. |

`tests/verify/roles.test.mjs` keeps them apart: only setup and the driver start a process, the checker only reads, and a check imports nothing.

Run it, read the table, and on FAIL fix the product, not the check. After three failed rounds, stop and report BLOCKED with the last table.

## The command

```shell
bun tools/verify.mjs --tier surface   # every change
bun tools/verify.mjs --tier all       # also when the mandate or skill routing changes
```

The first line is the verdict, then the evidence table. Evidence goes to `<git dir>/pstack-verify/runs/<run>/`, outside the working tree. `.claude/skills/verify/SKILL.md` says how to read it.

## The tiers

| Tier | Checks | Cost | Needs |
| --- | --- | --- | --- |
| surface | S1 to S6, S10 | no model call, $0, about 6 s | `claude` on PATH, at least the version in `tools/verify/cli-pin.json` |
| behavior | B1 to B5 | 15 haiku calls, about $0.05, capped at $0.50 | a login, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |

| Check | Holds |
| --- | --- |
| S1 | The plugin provides what the tree holds: every skill and agent under its own name, the hooks, no command, every `pstack:` name the tree mentions, and the inventory in the check file. |
| S2 | The plugin loads from the tree with no error, and every user-invocable skill reaches the session. |
| S3 | The mandate arrives once at startup, byte for byte, with exit 0 and no stderr. |
| S4 | The same on resume and clear, and the matcher covers compact. |
| S5 | `PSTACK_SESSION_HOOK=off`, and `session hook: off` in the user's sheet or in the project's `.claude/pstack-models.md`, turn the mandate off; `on` and no switch do not. |
| S6 | Each typed `/pstack:<skill>` is resolved before any model call; only the `principle-*` leaves are refused; an unknown name is passed on. |
| S10 | The marketplace manifest validates and names the plugin directory, name and version the tree holds. |
| B1 to B5 | With the mandate a multi-file bug routes to `poteto-mode` and a small question does not; a named skill loads; a typed `/pstack:how` reaches a subagent; without the mandate the bug does not route. [verify-behavior-tier.md](verify-behavior-tier.md) has the prompts and pass rules. |

Run `--tier all` when the change touches the mandate (`hooks/session-start-context.md`, `session-start.sh`, `hooks.json`), a skill's `name`, `description` or `user-invocable`, `poteto-mode`, `why` or `how`, or a B check.

## The verdict words

The first line reads `WORD <tier> | <tier> | round N`, for example `PARTIAL surface 7/7 | behavior NOT RUN | round 1`.

| Word | Means |
| --- | --- |
| PASS | Every check passed against the `claude` on PATH. |
| PARTIAL | Nothing failed, and some checks did not run: `--tier` or `--flow` left them out (`behavior NOT RUN`), or the model tier had no credential (`behavior NOT RUN: no credential`). A surface-only run prints this, and with `surface n/n` it is the expected result. |
| FAIL | A check failed, was unobservable, could not be judged, or the run went over its budget. Exit 1. |
| STAND-IN | Nothing failed against a CLI that is not Claude Code, or one named by `PSTACK_VERIFY_CLAUDE`. Proves nothing about the CLI a user has. |
| SKIPPED | No `claude` on PATH. `PSTACK_VERIFY_REQUIRE_CLI=1` makes it FAIL. |
| RECHECK | `bun tools/verify.mjs check <run>` reran the checker on saved traces. Never a verdict for a push. |
| BLOCKED | Never printed by the verifier. The push gate says it after three failed rounds; you report it when the run cannot happen. |

`tools/verify/verdict.mjs` is the one reader of this line. For `surface` it accepts PASS, or PARTIAL with every surface check passed and every other tier `NOT RUN` or `NOT BUILT`. For `all` it accepts only PASS with every tier n/n.

## The gate

`tools/verify/gate.mjs` refuses `git push`, `gh pr create` and `gh pr new` on a commit that touches a watched path until `bun tools/verify.mjs --tier surface`, run on a clean checkout of that commit, is accepted by `verdict.mjs surface`. It never reads a receipt. It loads two ways: the `PreToolUse` hook in `.claude/settings.json`, when Claude Code starts at the repository or worktree root, and a git `pre-push` hook (`prek install`, then `bun tools/verify/gate.mjs install-hook`). `PSTACK_VERIFY_GATE=off`, set by the human, bypasses it and says so; `git push --no-verify` skips the git hook. [CONTRIBUTING.md](../CONTRIBUTING.md) has the details.

## CI

`.github/workflows/behavior.yml` runs on every pull request, on pushes to main, nightly and by hand.

| Job | Runs | Passes on |
| --- | --- | --- |
| Claude Code surface (no model calls) | `--tier surface` against the pinned CLI | `verdict.mjs surface` |
| Verifier honesty (no model calls) | `honesty`, then `honesty --base` against the pull request's base | every planted mistake caught, and the ratchet holding |
| Claude Code behavior (haiku) | `--tier all --require-behavior` with the credential in the `claude-behavior` environment | `verdict.mjs all`; with no credential it passes and says SKIPPED in a notice and the summary |

A pull request from a fork gets no secret and a job that says the model tier did not run. CI reruns everything from scratch, and its verdict is the one that counts.

## Honesty

A check that passes on a broken plugin is worse than none. `bun tools/verify.mjs honesty` plants every mistake in `tools/verify/mutants/` in a scratch copy and runs the real surface tier on each; today it catches 55 of 55, with no known escape. Every assertion of a surface check is named by a planted mistake; every assertion of a behavior check is proved by a doctored recording instead, since planting one would drive a model. [verifier-honesty.md](verifier-honesty.md) has the file format, the ratchet and the rules.

## Escaped bugs

A bug that reached a release gets an entry in `tools/verify/escapes.json` in the pull request that fixes it: the `CHANGES.md` version, one line, and the check or test that now fails on it. The order is: plant the bug and show the check fails on it, merge the fix, then merge the check with its planted mistake. A second bug of the same class goes into the generator as a rule, not into another check. `tests/verify/escapes.test.mjs` holds the entries to that shape; it cannot tell that the named check fails on the bug, so the reviewer does.

## Add a check

1. A flow, `tools/verify/flows/<id>-<name>.mjs`: the tier and the runs (arguments, stdin, environment, files).
2. A check, `tools/verify/checks/<id>-<name>.mjs`: a title, the same tier and runs, and `assertions()` over the traces. It imports nothing and reads only structured events. A behavior check states its pass rule and caps its turns and budget in its arguments.
3. Recordings, `tests/verify/fixtures/untouched.<id>.<run>.jsonl`, one per run on the untouched tree. Scrub a signed-in one with `bun tests/verify/scrub.mjs`.
4. A test, `tests/verify/checks/<id>-<name>.test.mjs`, that doctors the recordings one fact at a time and shows each assertion turn.
5. For a surface check, a planted mistake in `tools/verify/mutants/` naming each assertion, shown caught by `bun tools/verify.mjs honesty --mutant <id>`. For a behavior check, a `TRACE_ONLY` entry per assertion in `tests/verify/honesty.test.mjs`.
6. An entry in `tools/verify/feature-map.json` naming the paths it covers.

`roles.test.mjs`, `honesty.test.mjs` and `feature-map.test.mjs` each say which of these is missing. Change a check in a pull request of its own, never with product code, and retire one only in a pull request that says why.

## Deliberately not covered

- Other runtimes: Codex, Pi, Copilot, Muse, MiniMax, Grok, Antigravity, OpenCode. They have their own tests.
- Installing from a marketplace or by version. S10 validates the manifest; nothing runs `/plugin marketplace add` or the updater.
- Skill bodies, references and scripts, and plugin agents' behavior. S1 and S6 judge that skills and agents load and resolve; only `poteto-mode`, `why` and `how` are driven with a model.
- Hook events other than SessionStart, and compact, which no surface run can drive (S4 reads the matcher instead).
- The interactive slash menu and Windows.
- Whether the mandate picks a skill unprompted: B3 names it. See [verify-behavior-tier.md](verify-behavior-tier.md#measured-and-not-a-check).
- Sessions started outside the repository root, and `--no-verify`, which the gate cannot see.
- The project sheet found from a subdirectory. S5 lays `.claude/pstack-models.md` in a working directory that is no repository, so the hook's walk up to the repository root never runs.

`tools/verify/feature-map.json` lists every uncovered path with its reason.
