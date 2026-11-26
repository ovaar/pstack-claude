// Answers to eb15d76 and the class of d523013: the routing mandate must reach
// a new session once, exactly as the tree holds it.
export const title = "the mandate arrives at startup";
export const tier = "surface";

const HOOK = "SessionStart:startup";
const MANDATE = "plugins/pstack/hooks/session-start-context.md";

export function assertions({ trace, stage, missing }) {
  const responses = trace("startup")
    .hooks()
    .filter((hook) => hook.name === HOOK);
  const [hook] = responses.length ? responses : missing(`a hook_response named ${HOOK}`);
  const mandate = stage.sha256(MANDATE);
  return [
    { id: "one-response", ok: responses.length === 1, saw: `${responses.length} hook_response named ${HOOK}`, want: "exactly 1" },
    { id: "exit-code", ok: hook.exitCode === 0, saw: `exit_code ${hook.exitCode}`, want: "exit_code 0" },
    { id: "outcome", ok: hook.outcome === "success", saw: `outcome ${hook.outcome}`, want: "outcome success" },
    // Equal sha256 over the bytes is how byte-equal is shown in the evidence.
    {
      id: "stdout",
      ok: mandate !== null && hook.stdoutSha256 === mandate,
      saw: `stdout sha256 ${hook.stdoutSha256} (${hook.stdoutBytes} bytes)`,
      want: mandate ? `the stage's hooks/session-start-context.md, sha256 ${mandate}` : "the stage's hooks/session-start-context.md, which is not there",
    },
    { id: "stderr", ok: hook.stderr === "", saw: hook.stderr ? `stderr ${JSON.stringify(hook.stderr.trim())}` : "empty stderr", want: "empty stderr" },
  ];
}
