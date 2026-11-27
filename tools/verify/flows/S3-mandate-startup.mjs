// A session fed stream-json with nothing on stdin runs the SessionStart hook
// and ends without an init or a result event, so nothing would tie the hook
// to the stage. One local command on stdin makes the session emit both, still
// with no model call.
export const tier = "surface";

const typed = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

export const runs = [{ name: "startup", args: ["--input-format", "stream-json"], stdin: typed("/context") }];
