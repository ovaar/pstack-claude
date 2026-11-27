// Answers to 278d485 and the class of c02fd49: a user who turns the session
// hook off gets no mandate, and one who has not gets it. Four runs through
// the real CLI differ in one thing each. The control has neither switch and
// must get the mandate, which ties an empty stdout elsewhere to the switch
// and not to a hook that prints nothing. `PSTACK_SESSION_HOOK=on` must get the
// mandate too, which keeps the switch from being any value at all.
// `PSTACK_SESSION_HOOK=off` in the environment and `session hook: off` in
// pstack-models.md under the config directory must each leave the hook's
// stdout empty. Setup adds the variable
// and writes the sheet, and the integrity rules hold the run to them.
export const title = "the session hook switches turn the mandate off";
export const tier = "surface";
const INPUT = ["--input-format", "stream-json"];
export const args = { control: INPUT, "env-off": INPUT, "env-on": INPUT, "sheet-off": INPUT };
export const env = { "env-off": { PSTACK_SESSION_HOOK: "off" }, "env-on": { PSTACK_SESSION_HOOK: "on" } };
export const files = { "sheet-off": { "pstack-models.md": "session hook: off\n" } };

const HOOK = "SessionStart:startup";
const MANDATE = "plugins/pstack/hooks/session-start-context.md";

export function assertions({ trace, stage }) {
  const mandate = stage.sha256(MANDATE);
  const found = [];
  for (const [run, silent] of [["control", false], ["env-on", false], ["env-off", true], ["sheet-off", true]]) {
    const responses = trace(run)
      .hooks()
      .filter((hook) => hook.name === HOOK);
    const [hook] = responses;
    found.push({ id: `${run}-ran`, ok: responses.length === 1 && hook.exitCode === 0 && hook.outcome === "success" && hook.stderr === "", saw: hook ? `${responses.length} hook_response named ${HOOK}; exit_code ${hook.exitCode}; outcome ${hook.outcome}${hook.stderr ? `; stderr ${JSON.stringify(hook.stderr.trim())}` : ""}` : `no hook_response named ${HOOK}`, want: `exactly 1 hook_response named ${HOOK}, exit_code 0, outcome success, empty stderr` });
    found.push(
      silent
        ? { id: `${run}-silent`, ok: hook?.stdoutBytes === 0, saw: hook ? `stdout ${hook.stdoutBytes} bytes` : "no hook response", want: "stdout of 0 bytes" }
        : { id: `${run}-mandate`, ok: mandate !== null && hook?.stdoutSha256 === mandate, saw: hook ? `stdout sha256 ${hook.stdoutSha256} (${hook.stdoutBytes} bytes)` : "no hook response", want: mandate ? `the stage's hooks/session-start-context.md, sha256 ${mandate}` : "the stage's hooks/session-start-context.md, which is not there" },
    );
  }
  return found;
}
