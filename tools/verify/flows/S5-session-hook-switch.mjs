// The hook is silenced by PSTACK_SESSION_HOOK=off, and by `session hook: off`
// in pstack-models.md under the config directory or in .claude/ of the
// project the session starts in. Each switch gets a run, and
// a run with neither is the control, so that an empty stdout cannot be a hook
// that prints nothing in every case. A run with the variable set to on tells
// the switch from any value at all. Setup adds the variable and writes the
// sheet, and nothing else of the parent's environment reaches a session. The
// project sheet is laid in the working directory, which is no repository, so
// the hook's repository root is that directory.
export const tier = "surface";

const typed = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
const input = ["--input-format", "stream-json"];

export const runs = [
  { name: "control", args: input, stdin: typed("/context") },
  { name: "env-off", args: input, stdin: typed("/context"), env: { PSTACK_SESSION_HOOK: "off" } },
  { name: "env-on", args: input, stdin: typed("/context"), env: { PSTACK_SESSION_HOOK: "on" } },
  { name: "sheet-off", args: input, stdin: typed("/context"), files: { "pstack-models.md": "session hook: off\n" } },
  { name: "project-sheet-off", args: input, stdin: typed("/context"), project: { ".claude/pstack-models.md": "session hook: off\n" } },
];
