// The tool that turns a run's trace into a fixture. What it keeps has to be
// what the checker reads, and what it drops must not be the only copy of a
// name from the machine it ran on.
import { expect, test } from "bun:test";

import { readTrace } from "../../tools/verify/trace.mjs";
import { compact, firstInit, reduceStream, reduceTranscript, scrub } from "./scrub.mjs";

const lines = (...records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

test("one pretty-printed document becomes one line, and a stream is left as it is", () => {
  expect(compact(JSON.stringify({ success: true, provides: { skills: ["a"] } }, null, 2))).toBe('{"success":true,"provides":{"skills":["a"]}}\n');
  const stream = lines({ type: "system", subtype: "init" }, { type: "result" });
  expect(compact(stream)).toBe(stream);
  expect(compact("not JSON")).toBe("not JSON");
});

test("a stream that repeats its init event keeps the first", () => {
  const init = (n) => ({ type: "system", subtype: "init", n });
  expect(firstInit(lines(init(1), { type: "result" }, init(2), { type: "result" }, init(3)))).toBe(lines(init(1), { type: "result" }, { type: "result" }).trimEnd() + "\n");
});

test("a transcript keeps the user lines and the unknown-command records, each user line to the head of its text", () => {
  const transcript = lines(
    { type: "attachment", attachment: { type: "hook_success", hookName: "SessionStart:startup" } },
    { type: "user", message: { role: "user", content: "<command-name>/pstack:bro</command-name>" } },
    { type: "user", isMeta: true, uuid: "x", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: <STAGE>/plugins/pstack/skills/bro\n\n# the skill's own text" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] } },
    { type: "attachment", attachment: { type: "unknown_command_fallback", detail: "a long text" } },
  );
  expect(reduceTranscript(transcript)).toBe(
    lines(
      { type: "user", message: { role: "user", content: "<command-name>/pstack:bro</command-name>" } },
      { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: <STAGE>/plugins/pstack/skills/bro" }] } },
      { type: "attachment", attachment: { type: "unknown_command_fallback" } },
    ),
  );
});

test("the stage and the sandbox become placeholders, and every session id a numbered one", () => {
  const out = scrub('{"cwd":"/s/stage/x","a":"0343da51-7150-4aab-bd03-e634ead8b33c","b":"0343da51-7150-4aab-bd03-e634ead8b33c","sandbox":"/s/box"}', "/s/stage", "/s/box");
  expect(out).toBe('{"cwd":"<STAGE>/x","a":"00000000-0000-4000-8000-000000000001","b":"00000000-0000-4000-8000-000000000001","sandbox":"<SANDBOX>"}');
});

// The reduction is for a stream too long to commit. It may drop what no
// accessor of the trace reader returns, and nothing else.
test("a reduced stream reads the same through every accessor as the stream it came from", () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 }, server_tool_use: { web_search_requests: 0 } };
  const replay = { type: "user", isReplay: true, uuid: "u", timestamp: "t", message: { role: "user", content: "<command-name>/pstack:bro</command-name>" } };
  const assistant = { type: "assistant", message: { diagnostics: null, id: "a", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in" }], usage } };
  const result = { type: "result", subtype: "success", is_error: true, total_cost_usd: 0, num_turns: 1, modelUsage: {}, permission_denials: [], subagent_stats: { spawned: 1, completed: 1, by_type: { "pstack:poteto-agent": 1 } }, duration_ms: 12, usage, result: "Not logged in", session_id: "s", uuid: "r" };
  const full = lines({ type: "system", subtype: "init", cwd: "/c", plugins: [{ name: "pstack", path: "/p", source: "pstack@inline", version: "1" }], skills: ["pstack:bro"] }, replay, assistant, result, replay, assistant, result);
  const [whole, reduced] = [full, reduceStream(full)].map((text) => readTrace(text));
  for (const name of ["init", "hooks", "results", "models", "userEvents", "replays", "toolUses", "toolResults", "exchanges"]) expect(reduced[name]()).toEqual(whole[name]());
  expect(Buffer.byteLength(reduceStream(full))).toBeLessThan(Buffer.byteLength(full));
});

test("a reduced stream keeps the model a message was signed by and the models that were billed", () => {
  const signed = lines({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "hi" }] } }, { type: "result", total_cost_usd: 0.01, modelUsage: { "claude-haiku-5-5": { inputTokens: 5 } }, result: "hi" });
  expect(readTrace(reduceStream(signed)).models()).toEqual(["claude-haiku-5-5"]);
});
