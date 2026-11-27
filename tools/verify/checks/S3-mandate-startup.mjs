// Answers to eb15d76 and the class of d523013: the routing mandate must reach
// a new session once, exactly as the tree holds it.
export const title = "the mandate arrives at startup";
export const tier = "surface";
export const args = { startup: ["--input-format", "stream-json"] };

const HOOK = "SessionStart:startup";
const MANDATE = "plugins/pstack/hooks/session-start-context.md";

export function assertions({ trace, stage, missing }) {
  const session = trace("startup");
  const responses = session.hooks().filter((hook) => hook.name === HOOK);
  const [hook] = responses.length ? responses : missing(`a hook_response named ${HOOK}`);
  const init = session.init() ?? missing("the init event");
  const mandate = stage.sha256(MANDATE);
  const named = [...new Set(hook.stdout.match(/pstack:[a-z0-9][a-z0-9-]*/g) ?? [])];
  const unloaded = named.filter((name) => !init.skills.includes(name));
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
    // `stdout` compares the hook with the file it prints, so an emptied
    // mandate passes it. This one does not rest on that file: a mandate
    // routes only through skills the same session loaded.
    {
      id: "skills-named",
      ok: named.length > 0 && unloaded.length === 0,
      saw: !named.length ? "no pstack: skill named in stdout" : unloaded.length ? `named in stdout and not in init.skills: ${unloaded.join(", ")}` : `${named.length} pstack: skills named in stdout, each in init.skills`,
      want: "at least 1 pstack: skill named in stdout, each in init.skills",
    },
    { id: "stderr", ok: hook.stderr === "", saw: hook.stderr ? `stderr ${JSON.stringify(hook.stderr.trim())}` : "empty stderr", want: "empty stderr" },
  ];
}
