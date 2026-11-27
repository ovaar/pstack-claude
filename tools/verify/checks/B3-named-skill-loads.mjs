// B3. An intent the mandate lists, said outright. An attempt counts when the
// session called the Skill tool for pstack:why and the call came back without
// an error. Measured on haiku, the same question without the skill's name did
// not load it, so this shows that a pstack skill loads by name.
export const title = "a skill the prompt names loads through the Skill tool";
export const tier = "behavior";
// The pass rule. A model is not deterministic, so each behavior is sampled
// and the check passes on this many attempts, every one of them in the evidence.
export const rule = { attempts: 3, needs: 2 };

const PROMPT = "Use the pstack:why skill to explain why totals.py applies tax after summing the cart instead of per line item.";
const ARGS = ["--max-turns", "1", "--max-budget-usd", "0.03", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", PROMPT];
export const args = { "attempt-1": ARGS, "attempt-2": ARGS, "attempt-3": ARGS };

const HOOK = "SessionStart:startup";
const ENDED = ["success", "error_max_turns"];

const SKILL = "pstack:why";

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
    const loaded = Boolean(skill?.result) && !skill.result.isError;
    return {
      id: name,
      attempt: true,
      ok: loaded,
      saw: skill ? `Skill ${SKILL} was call ${skill.index + 1} of ${calls.length}, ${loaded ? "and it loaded" : "and it did not load"}` : `no Skill call for ${SKILL} in ${calls.length} calls${calls.length ? ` (${calls.map(said).join(", ")})` : ""}`,
      want: `a loaded Skill ${SKILL}`,
    };
  });
  const loaded = attempts.filter((each) => each.ok).length;
  return [
    { id: "mandate-arrived", ok: hooks.every((hook) => hook.exitCode === 0 && hook.stdoutBytes > 0), saw: hooks.map((hook) => `exit_code ${hook.exitCode}, ${hook.stdoutBytes} bytes`).join("; "), want: "every attempt's SessionStart hook exit_code 0 with a mandate on stdout" },
    { id: "ended-normally", ok: ended.every((subtype) => ENDED.includes(subtype)), saw: `result subtypes ${ended.join(", ")}`, want: `each one of ${ENDED.join(", ")}` },
    ...attempts,
    { id: "pass-rule", ok: loaded >= rule.needs, saw: `${loaded} of ${rule.attempts} attempts loaded ${SKILL}`, want: `at least ${rule.needs} of ${rule.attempts} attempts loaded ${SKILL}` },
  ];
}
