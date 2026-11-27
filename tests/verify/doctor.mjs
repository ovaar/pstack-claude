// Ways to doctor a recorded model-tier trace, for the tests of B1 to B5. Each
// takes the events of one recording and returns the events of a session that
// differs in the one fact a check is meant to catch.

const MODEL = "claude-haiku-5-5";

export const assistantBlocks = (events, type) => events.filter((event) => event.type === "assistant").flatMap((event) => event.message.content.filter((block) => block.type === type));
export const toolUses = (events) => assistantBlocks(events, "tool_use");
export const resultBlocks = (events) => events.filter((event) => event.type === "user" && Array.isArray(event.message.content)).flatMap((event) => event.message.content.filter((block) => block.type === "tool_result"));
export const hookResponse = (events) => events.find((event) => event.subtype === "hook_response");
export const lastResult = (events) => events.find((event) => event.type === "result");

const assistant = (id, content) => ({ type: "assistant", parent_tool_use_id: null, message: { id, model: MODEL, role: "assistant", content } });
const callsTool = (event) => event.type === "assistant" && event.message.content.some((block) => block.type === "tool_use");
const returnsTool = (event) => event.type === "user" && Array.isArray(event.message.content) && event.message.content.some((block) => block.type === "tool_result");

// The session never made a tool call, and says it made one. What a model
// writes is not an event a check may read, so this must not read as a call.
export function saidSo(events, sentence) {
  const kept = events.filter((event) => !callsTool(event) && !returnsTool(event) && !event.isSynthetic);
  const at = kept.findIndex((event) => event.type === "result");
  return [...kept.slice(0, at), assistant("msg_said_so", [{ type: "text", text: sentence }]), ...kept.slice(at)];
}

// The session makes a call of its own before the first call it made.
export function firstCall(events, name, input) {
  const at = events.findIndex(callsTool);
  return [...events.slice(0, at), assistant("msg_first_call", [{ type: "tool_use", id: "toolu_first_call", name, input }]), ...events.slice(at)];
}

// Every call the session made, with a different name or input.
export function recall(events, change) {
  for (const block of toolUses(events)) change(block);
  return events;
}

// What the CLI writes for a call the API refused, or with nobody signed in
// (`error` null): no call is billed, and the message it writes is its own.
export function refused(events, error = "authentication_failed") {
  const kept = events.filter((event) => !callsTool(event) && !returnsTool(event) && !event.isSynthetic);
  const at = kept.findIndex((event) => event.type === "result");
  const message = { ...assistant("msg_refused", [{ type: "text", text: "Invalid API key" }]), ...(error ? { error } : {}) };
  message.message.model = "<synthetic>";
  const result = { ...kept[at], total_cost_usd: 0, modelUsage: {}, is_error: true, terminal_reason: "api_error" };
  return [...kept.slice(0, at).filter((event) => event.type !== "assistant"), message, result];
}
