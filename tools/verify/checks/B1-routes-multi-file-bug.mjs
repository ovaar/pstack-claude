// B1. The mandate says a task that touches more than one file, or changes a
// signature other files call, goes to pstack:poteto-mode. This one plainly
// does. An attempt counts as routed when the session called the Skill tool
// for pstack:poteto-mode, the call came back without an error, and no Edit or
// Write came before it. A denied Edit still shows as a tool_use, so a session
// that edits first is seen.
export const title = "a multi-file bug routes to poteto-mode before the first edit";
export const tier = "behavior";
// The pass rule. A model is not deterministic, so each behavior is sampled
// and the check passes on this many attempts, every one of them in the evidence.
export const rule = { attempts: 3, needs: 2 };

const PROMPT = "There is a bug whose cause is not yet known: order totals are sometimes off by one cent. The logic spans cart.py, tax.py and totals.py, and the fix will likely change a function signature the other files call. Begin working on it now.";
const ARGS = ["--max-turns", "1", "--max-budget-usd", "0.03", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", PROMPT];
export const args = { "attempt-1": ARGS, "attempt-2": ARGS, "attempt-3": ARGS };

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
    const skill = calls.find((call) => call.skill === SKILL);
    const edit = calls.find((call) => call.changes);
    const loaded = Boolean(skill?.result) && !skill.result.isError;
    const first = skill ? `Skill ${SKILL} was call ${skill.index + 1} of ${calls.length}, ${loaded ? "and it loaded" : "and it did not load"}` : `no Skill call for ${SKILL} in ${calls.length} calls${calls.length ? ` (${calls.map(said).join(", ")})` : ""}`;
    return {
      id: name,
      attempt: true,
      ok: loaded && (!edit || skill.index < edit.index),
      saw: `${first}; first Edit or Write: ${edit ? `call ${edit.index + 1}` : "none"}`,
      want: `a loaded Skill ${SKILL} before the first Edit or Write`,
    };
  });
  const routed = attempts.filter((each) => each.ok).length;
  return [
    // Without the mandate there is nothing to measure, and the sheet of a
    // person who signed in locally may have switched it off.
    { id: "mandate-arrived", ok: hooks.every((hook) => hook.exitCode === 0 && hook.stdoutBytes > 0), saw: hooks.map((hook) => `exit_code ${hook.exitCode}, ${hook.stdoutBytes} bytes`).join("; "), want: "every attempt's SessionStart hook exit_code 0 with a mandate on stdout" },
    { id: "ended-normally", ok: ended.every((subtype) => ENDED.includes(subtype)), saw: `result subtypes ${ended.join(", ")}`, want: `each one of ${ENDED.join(", ")}` },
    ...attempts,
    { id: "pass-rule", ok: routed >= rule.needs, saw: `${routed} of ${rule.attempts} attempts routed`, want: `at least ${rule.needs} of ${rule.attempts} attempts routed` },
  ];
}
