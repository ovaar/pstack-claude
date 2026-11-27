# The model tier of the verifier

`bun tools/verify.mjs --tier behavior` (and `--tier all`) drives real Claude Code sessions with `--model haiku` against a stage of this tree, and the checker judges them. The tier answers whether the mandate and the skills do what they say once a model is in the loop. It is sampled, small and capped. The zero-model tier, `--tier surface`, stays the one that must pass on every change.

## Running it

- Signed in as yourself, run `bun tools/verify.mjs --tier behavior`. With neither variable below set, the sessions use your login (`claude auth status` decides), your home and your config directory, with `--setting-sources ''`, `--strict-mcp-config` and `--no-session-persistence`, so your own settings, hooks and MCP servers stay out and nothing is written to your transcripts.
- In CI, or to use another account, set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. The sessions get a throwaway home and config directory, and the variable by name. Evidence records only the names.
- With neither a variable nor a login, the first line reads `behavior NOT RUN: no credential` and the word is PARTIAL, never PASS. `--require-behavior` makes it FAIL.
- A credential the API refuses is an error that says `credential present but rejected`, not a skipped tier.
- The first line carries the model calls and the cost: `PASS surface 2/2 | behavior 5/5 (15 model calls, $0.0459) | round 1`.

## What it may cost

Every session sets `--max-turns 1`, `--max-budget-usd 0.03` and a time limit. Setup refuses a plan whose caps add up to more than `BUDGET_USD` ($0.50) or `MAX_MODEL_CALLS` (25 turns) in `tools/verify/paths.mjs`, and the checker fails a run whose billed cost went over `BUDGET_USD` or whose model calls, counted from the distinct message ids in the traces, went over `MAX_MODEL_CALLS`; the first line then ends in `over the $0.5 budget` or `over the 25 model call limit`. The shipped plan is 15 sessions, at most $0.45.

A turn limit does not bound a subagent: an earlier B4 let its dispatch run, and one attempt made eight calls through it (a run was 26 calls, over the limit, and nothing failed it). B4 now passes `--settings` with a `PreToolUse` hook that denies `Agent|Task`. The call stays in the stream, which is all the check reads, and the subagent never runs. Measured on CLI 2.1.332 and haiku, a full run is 15 model calls (one per session) and $0.046. Sessions signed in locally also leave an empty project directory in your real config directory; the run removes those, and only those named after its own sandbox and holding no file.

## The checks

A model is not deterministic, so each check samples attempts, states its pass rule in its file (`export const rule`) and shows every attempt in the evidence. Verdicts come from the stream's records only: `tool_use` blocks (name and input), the `is_error` flag of their `tool_result`, hook responses, replayed user messages and the result subtype. No check reads what the model wrote, and none uses a judge.

| Check | Prompt | An attempt counts when | Pass rule |
| --- | --- | --- | --- |
| B1 | a bug across three files, with a signature to change | the session called the Skill tool for `pstack:poteto-mode`, it came back without an error, and no Edit or Write came first | 2 of 3 |
| B2 | which git command lists the files changed in the last commit | no Skill call for `pstack:poteto-mode` | 2 of 3 |
| B3 | use `pstack:why` to explain a design choice | a loaded Skill call for `pstack:why` | 2 of 3 |
| B4 | a typed `/pstack:how ...` | an Agent call whose prompt holds the brief from the stage's `skills/how/SKILL.md` | 2 of 3 |
| B5 | B1's prompt, with `PSTACK_SESSION_HOOK=off` | no Skill call for `pstack:poteto-mode` | 2 of 3 |

Alongside the rule, each check holds a few things true of every attempt: the mandate arrived (B1 to B3: the hook exited 0 with a mandate on stdout), or the hook was off (B5: it exited 0 with nothing), and the session ended in `success` or `error_max_turns`. Every model-tier run also passes the integrity rules: billed above $0, a real model id, every tool result matching a tool call, and the declared arguments.

Read B1 with B5. B5 changes one thing from B1, the hook, which a test pins (the two flows differ in nothing else). B1 routes and B5 does not, so the mandate is what routes.

### What the stream shows (CLI 2.1.332)

- A model-invoked skill is a `tool_use` named `Skill` with `{"skill": "pstack:<name>"}`, then a `tool_result` of `Launching skill: pstack:<name>` with no `is_error`, then a synthetic user message that starts `Base directory for this skill:`. One turn is enough to see all three.
- A typed `/pstack:how` shows no `Skill` call. The harness resolves it before the model: with `--input-format stream-json --replay-user-messages` the replayed user message holds `<command-name>/pstack:how</command-name>`, and for an unknown name it holds the raw text. That is B4's deterministic half. Its sampled half is the model's first move: the skill's body tells it to hand a brief to one subagent, and the brief reaches an `Agent` call's prompt in 5 of 7 probe sessions, and 3 of 3 in the run. Nothing else holds those words, so it shows the body was loaded.
- A call the API refuses is an assistant message the CLI wrote itself, with `error: "authentication_failed"`, a synthetic model, a cost of 0 and `terminal_reason: "api_error"`. The exit code is 1 and the result subtype is `success`, so neither is a verdict.
- A session stopped by `--max-turns` has result subtype `error_max_turns`, `is_error` true and exit code 1. That is expected here.
- A denied Edit or Write is still a `tool_use` block, so a session that edits first is seen without letting it edit.
- On macOS a login needs the `USER` variable besides `HOME`, because the keychain entry is filed under it.

### Measured, and not a check

A why question that does not name the skill loaded `pstack:why` in 0 of 3 haiku sessions, and a test-first request loaded `pstack:tdd` in 0 of 3, with the mandate in place. Naming the skill did it in 3 of 3 each. So B3 shows that a pstack skill loads by name. It does not show that the mandate picks it unprompted, and a check that claimed that would fail today.

A mandate that says to route every message passes B1 and fails B2, and it also fails B3 and B4, because the session reaches for `pstack:poteto-mode` before the skill the prompt names.

## Recorded traces and privacy

A signed-in trace carries account data: the user name in a directory listing, home paths, session and account ids, and the account's rate-limit usage. Committed fixtures pass through the scrub tool:

```sh
bun tests/verify/scrub.mjs <run-directory> B1/attempt-1 untouched.B1.attempt-1
```

It drops rate-limit events, progress noise and repeated init events, cuts any text over 1200 characters (except the init event and hook responses, which checks read whole), and replaces the stage, the sandbox, the home directory, the user and machine names, emails every UUID, and the server-side ids a signed-in trace carries (`req_`, `msg_` and `toolu_` ids, and the `agent_id`, `task_id` and `run_id` of a background agent), which are renumbered so a result still points at its call and a message id still counts as one call. An organisation's name is not something the tool can know, so name it in `PSTACK_SCRUB_NAMES` (a comma list) when recording from an account that has one. `leaks()` in `tests/verify/scrub.mjs` refuses any fixture that still holds the user or machine name as a whole word in any case however short it is (only generic account words such as `user`, `root` and `test` are let through), any UUID that does not start with `00000000-0000-4000-8000-`, any server-side id that is not a placeholder, an email, a token, a home path or a temp directory. The live traces stay under the git directory with the run, never in the working tree, and only the redacted `evidence.md` is for pasting.

## Honesty

The fixtures include sessions that routed (B1), sessions that did not (B5, B2), and a subagent dispatch the hook refused (B4). A refused API call is not recorded: `doctor.mjs` writes that trace. The tests under `tests/verify/checks/B*.test.mjs` start from them and doctor one fact each, and the doctored trace must fail:

- a session that says it ran the skill with no `Skill` call (the old `SKILL-RAN` text match would pass it)
- a `Skill` call whose `tool_result` has `is_error` true while the process exits 0
- an Edit or Write before the Skill call, a different skill, a subagent's call in place of the session's own
- no mandate on stdout, or a mandate on stdout with the hook meant to be off
- a signed-out trace, a cost of 0, no real model id, a tool result with no call, a changed argument, a changed prompt
- a refused key

Planted mistakes in a scratch clone of the tree, each run through the real tier, are in the pull request's test run: the mandate replaced by a neutral sentence (B1 fails), `disable-model-invocation` on `why` (B3), `user-invocable: false` on `how` (B4), the hook ignoring the off switch (B5), and a mandate that routes every message (B2). The untouched tree passes all five.

## The CI job a later unit needs

This unit adds none. A later unit should add a workflow file of its own, never an edit to `ci.yml`:

- `credential` job in an environment such as `claude-behavior`: read `secrets.CLAUDE_CODE_OAUTH_TOKEN` and `secrets.ANTHROPIC_API_KEY` into step-level environment and write an output `present`. With both empty, print `::warning title=Behavior checks SKIPPED::no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY` and the same line in the job summary. A skipped job counts as green, so the job must never be a required check.
- `behavior` job with `needs: [credential]` and `if: needs.credential.outputs.present == 'true'`: checkout and setup-bun at 40-character SHAs, the CLI installed at the version `tools/verify/cli-pin.json` verifies, then `bun tools/verify.mjs --tier behavior --require-behavior --evidence "$RUNNER_TEMP/verify"` with the token in that one step's environment and nothing else. The evidence's `evidence.md` goes to the job summary. Behavior traces are not uploaded.
- Never `pull_request_target` and never `--bare`, which skips the plugin's hooks.
- The surface job's summary should say `behavior tier: NOT RUN in CI (no credential)` when the credential job found none.

## Not proven

- The tier has not run on Linux or in CI, and not with a real token in a throwaway config directory. The clean mode is covered by the stand-in and by a dummy key (`credential present but rejected`, measured with a zero-cost call).
- The rates are small samples on the `haiku` alias, which will point at other models over time. The evidence records the model id and the sample size.
- Every recorded session is from one machine and one account.
- B4's rate is the least certain: its subagent brief reached an `Agent` call in 5 of 7 earlier probe sessions and in 3 of 3 of the last run. At about 70 percent a rule of 2 of 3 would miss about one run in five, so a red B4 alone is rerun before it is read as a regression.
