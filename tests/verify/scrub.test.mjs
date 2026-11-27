// The tool that turns a run's trace into a fixture. What it keeps has to be
// what the checker reads, and what it drops must not be the only copy of a
// name from the machine it ran on.
import { expect, test } from "bun:test";

import { compact, firstInit, reduceTranscript, scrub } from "./scrub.mjs";

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
