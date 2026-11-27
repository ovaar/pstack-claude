// The mandate must reach a session on every source the hook is registered
// for. `/clear` typed into a session starts a new one, which fires
// SessionStart:clear; `--continue` in the directory of an earlier session
// resumes it, which fires SessionStart:resume. Neither calls a model: both
// are local, and /context only reports. `compact` is not driven. Measured on
// CLI 2.1.332: `/compact` in a session that has no messages for a model
// answers "Not enough messages to compact." and fires no hook, and a
// message a model could answer needs a login. The registered matcher is its
// only guard.
export const tier = "surface";

const typed = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
const input = ["--input-format", "stream-json"];

export const runs = [
  { name: "clear", args: input, stdin: typed("/clear") },
  { name: "resume", share: "clear", args: [...input, "--continue"], stdin: typed("/context") },
];
