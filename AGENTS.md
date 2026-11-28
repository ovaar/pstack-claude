# Agents in this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) for how the port works and [docs/verifier.md](docs/verifier.md) for the verifier of the Claude Code build. The verify skill is `.claude/skills/verify/SKILL.md`, and `.agents/playbooks/verifier-loop.md` hooks it into pstack's playbooks.

## Rules and what enforces them

A rule enforced by "prose" has no check: following it is on you and the reviewer.

| Rule | Enforced by |
| --- | --- |
| A change to `plugins/pstack`, `.claude-plugin`, `VERSION` or the verifier is pushed only after `bun tools/verify.mjs --tier surface` passes on that commit. | The push gate, `tools/verify/gate.mjs`, from `.claude/settings.json` and the git `pre-push` hook; the `Claude Code surface (no model calls)` CI job |
| A surface-only run passes with `PASS`, or `PARTIAL` with `surface n/n` and every other tier `NOT RUN` or `NOT BUILT`. | `tools/verify/verdict.mjs`, read by the gate and CI; `tests/verify/surface-verdict.test.mjs`, `tests/verify/gate.test.mjs` |
| A change to the mandate or skill routing also passes `bun tools/verify.mjs --tier all`. | Prose locally; the `Claude Code behavior (haiku)` CI job once a credential is set |
| On FAIL, fix the product, not the check. | Prose; the honesty ratchet fails when a check stops catching a planted mistake |
| Product and checks never change in the same pull request, and a check is retired only in a pull request of its own that says why. | Prose |
| Stop after three failed rounds and report BLOCKED. | The gate's message after the third failed round; otherwise prose |
| Do not set `PSTACK_VERIFY_GATE=off` or push with `--no-verify`. | Prose; only the human bypasses the gate |
| Verdicts come from structured events, never from what a model wrote. | `tests/verify/roles.test.mjs` (a check imports nothing); doctored traces that only say a skill ran fail B1 and B3 |
| Setup, driver and checker stay apart. | `tests/verify/roles.test.mjs` |
| Every surface assertion has a planted mistake that fails it; every behavior assertion has a doctored recording that does. | `tests/verify/honesty.test.mjs`; the `Verifier honesty (no model calls)` CI job |
| Known escapes only go down, and a caught mistake stays caught by the same check. | `tests/verify/honesty.test.mjs`; `bun tools/verify.mjs honesty --base` in CI |
| Every product path is in the feature map, and every check covers something in it. | `tests/verify/feature-map.test.mjs` |
| A bug that reached a release gets an entry in `tools/verify/escapes.json` with its fix. | Prose for the entry; `tests/verify/escapes.test.mjs` for its shape |
| Committed recordings hold no name, home path, email, token or real id. | `tests/verify/fixtures-clean.test.mjs` |
| Actions are pinned to 40-character SHAs, CI never uses `continue-on-error`, and the CLI version lives in `tools/verify/cli-pin.json`. | `tests/verify/cli-pin.test.mjs`, `tests/verify/behavior-workflow.test.mjs`, zizmor in CI |
| A credential reaches three steps of the behavior job and nothing else, never a pull request from a fork, and never the evidence. | `tests/verify/behavior-workflow.test.mjs`; the evidence search step in the job |
| Paste the first line and the table of `evidence.md` into the pull request's Test run section. | Prose |
