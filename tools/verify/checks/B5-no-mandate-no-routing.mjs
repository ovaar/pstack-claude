// B5. B1's prompt and project, with PSTACK_SESSION_HOOK=off. The hook still
// runs and prints nothing, which each attempt's hook_response shows, and an
// attempt counts as unrouted when the session made no Skill call for
// pstack:poteto-mode. Read with B1, it shows the mandate is what routes.
export const title = "with the session hook off, the same bug is not routed";
export const tier = "behavior";
// The pass rule. A model is not deterministic, so each behavior is sampled
// and the check passes on this many attempts, every one of them in the evidence.
export const rule = { attempts: 3, needs: 2 };

const PROMPT = "There is a bug whose cause is not yet known: order totals are sometimes off by one cent. The logic spans cart.py, tax.py and totals.py, and the fix will likely change a function signature the other files call. Begin working on it now.";
const ARGS = ["--max-turns", "1", "--max-budget-usd", "0.03", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", PROMPT];
export const args = { "attempt-1": ARGS, "attempt-2": ARGS, "attempt-3": ARGS };
const OFF = { PSTACK_SESSION_HOOK: "off" };
export const env = { "attempt-1": OFF, "attempt-2": OFF, "attempt-3": OFF };

const HOOK = "SessionStart:startup";
const ENDED = ["success", "error_max_turns"];

const SKILL = "pstack:poteto-mode";

// Verdicts come from the stream's own records: the hook's response, the
// tool calls and the result subtype. Nothing here reads what the model wrote.
export function assertions({ trace, missing }) {
  const sessions = Object.keys(args).map((name) => ({ name, session: trace(name) }));
  const hooks = sessions.map(({ session }) => {
    const [hook] = session.hooks().filter((each) => each.name === HOOK);
    return hook ?? missing(`a hook_response named ${HOOK}`);
  });
  const ended = sessions.map(({ session }) => session.result()?.subtype ?? "no result");
  const said = (call) => (call.skill ? `Skill ${call.skill}` : call.name);
  const attempts = sessions.map(({ name, session }) => {
    const calls = session.calls();
    const routed = calls.filter((call) => call.skill === SKILL);
    return {
      id: name,
      attempt: true,
      ok: routed.length === 0,
      saw: routed.length ? `Skill ${SKILL} as call ${routed[0].index + 1} of ${calls.length}` : `${calls.length} calls${calls.length ? ` (${calls.map(said).join(", ")})` : ""}, none for ${SKILL}`,
      want: `no Skill call for ${SKILL}`,
    };
  });
  const unrouted = attempts.filter((each) => each.ok).length;
  return [
    // The condition itself: the hook ran, and said nothing.
    { id: "hook-off", ok: hooks.every((hook) => hook.exitCode === 0 && hook.stdoutBytes === 0), saw: hooks.map((hook) => `exit_code ${hook.exitCode}, ${hook.stdoutBytes} bytes`).join("; "), want: "every attempt's SessionStart hook exit_code 0 with nothing on stdout" },
    { id: "ended-normally", ok: ended.every((subtype) => ENDED.includes(subtype)), saw: `result subtypes ${ended.join(", ")}`, want: `each one of ${ENDED.join(", ")}` },
    ...attempts,
    { id: "pass-rule", ok: unrouted >= rule.needs, saw: `${unrouted} of ${rule.attempts} attempts unrouted`, want: `at least ${rule.needs} of ${rule.attempts} attempts unrouted` },
  ];
}
