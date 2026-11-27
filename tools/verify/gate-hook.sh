#!/bin/sh
# Claude Code PreToolUse hook for Bash, registered in .claude/settings.json.
# It answers every command that cannot be a push or a pull request at once,
# from a string match and without starting bun, so it never slows or blocks
# ordinary Bash. Only a payload that may hold `git ... push` or
# `gh ... pr ... create` reaches tools/verify/gate.mjs, which parses the
# command properly and decides. Exit 2 blocks and stderr goes to the agent.
payload=$(cat)

case $payload in
  *git*push* | *gh*pr*create*) ;;
  *) exit 0 ;;
esac

if [ "${PSTACK_VERIFY_GATE:-}" = off ]; then
  echo "verify gate bypassed by PSTACK_VERIFY_GATE=off" >&2
  exit 0
fi

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 0

if ! command -v bun >/dev/null 2>&1; then
  # Without bun the command cannot be parsed. One that begins with, or is
  # chained to, `git push` or `gh pr create` is refused with the fix; anything
  # else gets through with the reason, including a push hidden in quotes.
  case $payload in
    *'"command":"git push'* | *'"command":"git -'*push* | *'"command":"gh pr create'* | *'&& git push'* | *'; git push'* | *'|| git push'* | *'&& gh pr create'* | *'; gh pr create'*)
      echo "verify gate: bun is not on PATH, so the verifier cannot run. Fix: install bun (https://bun.sh) and put it on PATH for the shell that started Claude Code, then push again. Only the human sets PSTACK_VERIFY_GATE=off, in the environment the session started in. Do not set it." >&2
      exit 2
      ;;
  esac
  echo "verify gate skipped: bun is not on PATH, and this command is not plainly a push" >&2
  exit 0
fi

printf '%s' "$payload" | exec bun "$here/gate.mjs" hook
