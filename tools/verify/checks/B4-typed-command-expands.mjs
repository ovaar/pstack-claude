// B4. A typed slash command is resolved by the harness before any model
// call, and the stream shows no Skill tool call for it (measured, CLI
// 2.1.332). Two things are observable. The replayed user message carries the
// command's name, which is the harness's doing and holds every time. And the
// body of the skill tells the model to hand a brief to one subagent: when that
// brief, taken from the stage's skills/how/SKILL.md, is in an Agent call's
// prompt, the body was loaded, because nothing else holds those words. The
// second is the model's choice, so it is sampled.
export const title = "a typed /pstack:how is expanded and its brief reaches a subagent";
export const tier = "behavior";
// The pass rule. A model is not deterministic, so each behavior is sampled
// and the check passes on this many attempts, every one of them in the evidence.
export const rule = { attempts: 2, needs: 1 };

// The command is typed on stdin as a user message, so it is not an argument.
const ARGS = ["--max-turns", "1", "--max-budget-usd", "0.03", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--input-format", "stream-json", "--replay-user-messages"];
export const args = { "attempt-1": ARGS, "attempt-2": ARGS };

const HOOK = "SessionStart:startup";
const ENDED = ["success", "error_max_turns"];

const COMMAND = "<command-name>/pstack:how</command-name>";
const SKILL_FILE = "plugins/pstack/skills/how/SKILL.md";

export function assertions({ trace, stage, missing }) {
  const sessions = Object.keys(args).map((name) => ({ name, session: trace(name) }));
  const ended = sessions.map(({ session }) => session.result()?.subtype ?? "no result");
  const said = (call) => (call.skill ? `Skill ${call.skill}` : call.name);
  const brief = stage.text(SKILL_FILE)?.match(/^>\s*(You are writing an[^.]*\.)/m)?.[1] ?? missing(`the subagent brief in the stage's ${SKILL_FILE}`);
  const resolved = sessions.map(({ session }) => session.replays().some((message) => message.text.includes(COMMAND)));
  const attempts = sessions.map(({ name, session }) => {
    const calls = session.calls();
    const dispatch = calls.find((call) => ["Agent", "Task"].includes(call.name) && typeof call.input.prompt === "string" && call.input.prompt.includes(brief));
    return {
      id: name,
      attempt: true,
      ok: Boolean(dispatch),
      saw: dispatch ? `${dispatch.name} call ${dispatch.index + 1} of ${calls.length}, subagent_type ${dispatch.input.subagent_type}, with the brief in its prompt` : `${calls.length} calls${calls.length ? ` (${calls.map(said).join(", ")})` : ""}, none carrying the brief`,
      want: "an Agent call whose prompt holds the brief from the skill",
    };
  });
  const dispatched = attempts.filter((each) => each.ok).length;
  return [
    { id: "command-resolved", ok: resolved.every(Boolean), saw: resolved.map((each) => (each ? "the command was replayed as a command" : "no replayed command")).join("; "), want: `every attempt replaying ${COMMAND}` },
    { id: "ended-normally", ok: ended.every((subtype) => ENDED.includes(subtype)), saw: `result subtypes ${ended.join(", ")}`, want: `each one of ${ENDED.join(", ")}` },
    ...attempts,
    { id: "pass-rule", ok: dispatched >= rule.needs, saw: `${dispatched} of ${rule.attempts} attempts carried the brief to a subagent`, want: `at least ${rule.needs} of ${rule.attempts} attempts carried the brief` },
  ];
}
