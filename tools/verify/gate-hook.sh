#!/bin/sh
# Claude Code PreToolUse hook for Bash, registered in .claude/settings.json.
# It answers every command that cannot be a push or a pull request at once,
# from a string match and without starting bun, so it never slows or blocks
# ordinary Bash. Only a payload that may hold a push or a pull request
# reaches tools/verify/gate.mjs, which parses the
# command properly and decides. Exit 2 blocks and stderr goes to the agent.
payload=$(cat)

# What a passing hook tells the agent is JSON on stdout: Claude Code shows the
# agent no stderr from a hook that exits 0. The messages hold no quote or
# backslash, so printf can build the JSON.
note() {
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$1" "$1"
}

# Quotes and backslashes are dropped first, so `gi''t push` is seen as the
# parser sees it. Matching `push`, or `pr` with `create` or `new`, on its own
# keeps this filter looser than the parser: it may send a command that is no
# push to bun, which costs about 50 ms, and never keeps back one that is.
flat=$(printf '%s' "$payload" | tr -d "\\\\'\"")
case $flat in
  *push* | *pr*create* | *pr*new*) ;;
  *) exit 0 ;;
esac

if [ "${PSTACK_VERIFY_GATE:-}" = off ]; then
  note "verify gate bypassed by PSTACK_VERIFY_GATE=off"
  exit 0
fi

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 0

if ! command -v bun >/dev/null 2>&1; then
  # Without bun the command cannot be parsed. One that begins with, or is
  # chained to, `git push` or `gh pr create` is refused with the fix; anything
  # else gets through with the reason, including a push hidden in quotes.
  case $payload in
    *'"command":"git push'* | *'"command":"git -'*push* | *'"command":"gh pr create'* | *'"command":"gh pr new'* | *'&& git push'* | *'; git push'* | *'|| git push'* | *'&& gh pr create'* | *'; gh pr create'*)
      echo "verify gate: bun is not on PATH, so the verifier cannot run. Fix: install bun (https://bun.sh) and put it on PATH for the shell that started Claude Code, then push again. Only the human sets PSTACK_VERIFY_GATE=off, in the environment the session started in. Do not set it." >&2
      exit 2
      ;;
  esac
  note "verify gate skipped: bun is not on PATH, and this command is not plainly a push"
  exit 0
fi

# Claude Code lets the tool run when a hook exits with anything but 0 or 2, so
# a gate that dies is made a 2 here.
printf '%s' "$payload" | bun "$here/gate.mjs" hook
rc=$?
case $rc in
  0 | 2) exit "$rc" ;;
esac
echo "verify gate: the gate itself failed (exit $rc), so the command is refused. Only the human sets PSTACK_VERIFY_GATE=off, in the environment the session started in. Do not set it." >&2
exit 2
