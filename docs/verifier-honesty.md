# Keeping the verifier honest

A check that passes on a broken plugin is worse than no check. `bun tools/verify.mjs honesty`
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
| `catches` | `{ check, assertion? }`: the check that must fail, and the assertion that must be among its failures |
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
when a check in `checks/` is the expected catcher of no mistake. Adding a check is therefore adding
a mistake it catches. Fixing an escape is lowering the baseline in the same commit.

What the test cannot see is a pull request that raises the baseline. That is a line in a diff a
reviewer reads. A comparison against the base branch is not built.

## In CI

There is no `.github/workflows/behavior.yml` on this branch, so no job was added. When it exists,
the surface job takes one more step after the surface tier:

```yaml
- name: Honesty (planted mistakes against the real CLI)
  run: bun tools/verify.mjs honesty --out "$RUNNER_TEMP/honesty.md" && cat "$RUNNER_TEMP/honesty.md" >> "$GITHUB_STEP_SUMMARY"
```

It makes no model call and needs no secret, only the CLI the surface job already installs. If the
step must run when the surface step fails, give it `if: always()`.
