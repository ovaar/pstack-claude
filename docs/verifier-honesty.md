# Keeping the verifier honest

Read [verifier.md](verifier.md) first. A check that passes on a broken plugin is worse than no check. `bun tools/verify.mjs honesty`
plants known mistakes in a throwaway copy of the tree, runs the real verifier on the copy with
`--tree`, and reports for each mistake whether the check that should catch it did.

```sh
bun tools/verify.mjs honesty                  # every mistake, against the claude on PATH
bun tools/verify.mjs honesty --mutant mandate-emptied --keep
```

The command needs the real CLI for a verdict that means something. Against a stand-in it says so
on its second line, and only what a check can tell from the tree alone is caught.

## A planted mistake

One JSON file per mistake in `tools/verify/mutants/`. The file name is the id.

| Key | Holds |
| --- | --- |
| `description` | what is broken, and the commit it re-creates when there is one |
| `edits` | the edit as data: `replace` (path, find, with), `write` (path, content), `delete` (path), `chmod` (path, mode) |
| `catches` | `{ check, assertion? }`: the surface check that must fail, and the assertion that must be among its failures |
| `known_escape` | `{ reason, future_check }` in place of `catches`: no check catches it yet |

Only product paths can be edited. The run is judged from the verifier's structured result, never
from prose.

- Caught: the named check failed, on the named assertion when one is named.
- Escaped: the check passed, or failed on something else. The command exits 1.
- Known escape: reported and does not fail the run. If a check starts catching it the run fails
  with `blind spot closed`, and the file moves to `catches`.
- Plant did not apply: an edit that finds nothing to change fails loudly with
  `PLANT DID NOT APPLY` and is never counted as a catch.
- The untouched copy has to pass first. If it does not, nothing else is judged.

## The ratchet

`tools/verify/baseline.json` holds the known escapes. `tests/verify/honesty.test.mjs` fails when
there are more known escapes than the baseline, when the baseline holds more than there are, and
when a surface check is the expected catcher of no mistake. Adding a check is therefore adding
a mistake it catches. Fixing an escape is lowering the baseline in the same commit.

A test inside one commit cannot stop that commit from raising its own baseline. So the same rules
are also held against the base branch:

```sh
bun tools/verify.mjs honesty --base origin/main
```

It runs no verifier. It compares `baseline.json` and the files in `mutants/` with the merge base of
`HEAD` and the ref, and exits 1 when the known escapes went up, or when a mistake the base catches is
gone, turned into a known escape, or pointed at another check or assertion. A base with no baseline
yet passes.

A check that cannot see the evidence it needs, such as a startup hook that never ran, is unobservable,
and the verifier fails the tree on it. A mistake that names only the check counts that as caught. A
mistake that names an assertion needs that assertion to fail.

Every assertion of every surface check is named by at least one mistake. The test reads the
assertions each check returns on its untouched recordings, so an id built from a run's name, such as
S4's `clear-stderr`, counts. A new assertion comes with the mistake that fails it. An assertion no
plant can reach on the pinned CLI goes in `TRACE_ONLY` in `tests/verify/honesty.test.mjs` with the
reason and a doctored recording that turns it. Two do today: `S1.valid`, because a manifest the
validator fails lists nothing the plugin provides and S1 is unobservable first, and `S6.answered`,
because the messages typed follow from the tree.

## The model tier

Honesty plants mistakes for the surface tier only. `--tier behavior` and `--tier all` are refused,
and so is a mistake that names a behavior check: each would drive a model and judge a sample. The
model tier's proof is its recordings. Every assertion of B1 to B5 has an entry in `TRACE_ONLY`, a
doctored copy of the untouched recording that must turn that assertion, and the test fails when an
assertion has none. The tests in `tests/verify/checks/B*.test.mjs` doctor more facts, listed in
[verify-behavior-tier.md](verify-behavior-tier.md#honesty).

## The table today

On CLI 2.1.332: `honesty: OK, 53 of 53 caught, 0 known escapes, 0 failing`. The five escapes found
on the core (matcher narrowed to startup, marketplace.json broken, agents directory removed, an
unnamed skill removed, a command shadowing a skill) are caught by S4, S10, S1, S1 and S6, and
`baseline.json` is 0.

## In CI

The `Verifier honesty (no model calls)` job in `.github/workflows/behavior.yml` runs
`bun tools/verify.mjs honesty` against the pinned CLI, then `honesty --base` against the pull
request's base branch (a push compares with the commit it replaced). The table goes to the job
summary in a step that always runs. It needs no secret.
