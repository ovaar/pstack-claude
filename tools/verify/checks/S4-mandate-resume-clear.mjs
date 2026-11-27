// Answers to af7aa63, a matcher that left a source out: the mandate must
// reach a session on every source the tree registers its hook for, exactly as
// the tree holds it. Startup is S3's. This drives clear and resume, and reads
// compact, which cannot be driven with no model call, from the matcher the
// stage registers: the three together are the whole of
// startup|resume|clear|compact.
export const title = "the mandate arrives on resume and clear";
export const tier = "surface";
export const args = {
  clear: ["--input-format", "stream-json"],
  resume: ["--input-format", "stream-json", "--continue"],
};

const MANDATE = "plugins/pstack/hooks/session-start-context.md";
const HOOKS = "plugins/pstack/hooks/hooks.json";
const SOURCES = ["startup", "resume", "clear", "compact"];
const DRIVEN = { clear: "clear", resume: "resume" };

function matchers(hooks) {
  try {
    return JSON.parse(hooks).hooks.SessionStart.map((entry) => entry.matcher || "*");
  } catch {
    return [];
  }
}

function covers(matcher, source) {
  try {
    return matcher === "*" || new RegExp(`^(?:${matcher})$`).test(source);
  } catch {
    return false;
  }
}

export function assertions({ trace, stage }) {
  const mandate = stage.sha256(MANDATE);
  const registered = matchers(stage.text(HOOKS));
  const uncovered = SOURCES.filter((source) => !registered.some((matcher) => covers(matcher, source)));
  const found = [
    {
      id: "registered",
      ok: uncovered.length === 0,
      saw: registered.length ? `SessionStart matcher ${registered.join(", ")}${uncovered.length ? `, which leaves out ${uncovered.join(", ")}` : ""}` : "no SessionStart hook in the stage's hooks.json",
      want: `a SessionStart matcher that covers ${SOURCES.join(", ")}; compact is not driven, so this is all that guards it`,
    },
  ];

  for (const [run, source] of Object.entries(DRIVEN)) {
    const name = `SessionStart:${source}`;
    const responses = trace(run)
      .hooks()
      .filter((hook) => hook.name === name);
    const [hook] = responses;
    const sees = (ok, saw, want, id) => found.push({ id: `${source}-${id}`, ok: Boolean(hook) && ok, saw: hook ? saw : `no hook_response named ${name}`, want });
    found.push({ id: `${source}-one-response`, ok: responses.length === 1, saw: `${responses.length} hook_response named ${name}`, want: "exactly 1" });
    sees(hook?.exitCode === 0, `exit_code ${hook?.exitCode}`, "exit_code 0", "exit-code");
    sees(hook?.outcome === "success", `outcome ${hook?.outcome}`, "outcome success", "outcome");
    // The same bytes the file holds, as S3 asks of startup.
    sees(mandate !== null && hook?.stdoutSha256 === mandate, `stdout sha256 ${hook?.stdoutSha256} (${hook?.stdoutBytes} bytes)`, mandate ? `the stage's hooks/session-start-context.md, sha256 ${mandate}` : "the stage's hooks/session-start-context.md, which is not there", "stdout");
    sees(hook?.stderr === "", hook?.stderr ? `stderr ${JSON.stringify(hook.stderr.trim())}` : "empty stderr", "empty stderr", "stderr");
  }
  return found;
}
