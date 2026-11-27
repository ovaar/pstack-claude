// trace.mjs is the only reader of the CLI's event names, so it is held to
// two recordings of zero-model runs and to hand-built events for what a
// zero-model run cannot produce. Those events copy the shapes of model runs
// recorded on CLI 2.1.332 (tool_use, tool_result, the skill body, a replayed
// slash command); the first unit that makes model calls should swap them for
// its own recordings.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readRun, readTrace } from "../../tools/verify/trace.mjs";
import { cleanup, tempDir } from "./harness.mjs";
import { FIXTURES } from "./scrub.mjs";

afterEach(cleanup);

const recorded = (name) => readTrace(readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8"));
const stream = (...events) => events.map((event) => `${JSON.stringify(event)}\n`).join("");

const CLAIM = "I ran the pstack:bro skill.";
const SKILL_BODY = "Base directory for this skill: /stage/plugins/pstack/skills/bro\n\nRestate your last message.";
const TYPED = "<command-message>pstack:bro</command-message>\n<command-name>/pstack:bro</command-name>";
const modelRun = stream(
  { type: "system", subtype: "init", claude_code_version: "2.1.332", plugins: [{ name: "pstack", path: "/stage/plugins/pstack", source: "pstack@inline", version: "0.9.158" }] },
  { type: "user", isReplay: true, message: { role: "user", content: TYPED } },
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: { model: "claude-haiku-5-5", content: [{ type: "text", text: CLAIM }, { type: "tool_use", id: "toolu_01", name: "Skill", input: { skill: "pstack:bro" }, caller: { type: "direct" } }] },
  },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "Launching skill: pstack:bro" }] } },
  { type: "user", isSynthetic: true, message: { role: "user", content: [{ type: "text", text: SKILL_BODY }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02", is_error: true, content: [{ type: "text", text: "Claude requested permissions to write" }] }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.0028,
    modelUsage: { "claude-haiku-5-5": { costUSD: 0.0028 } },
    permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_02", tool_input: { file_path: "probe-note.txt" } }],
    subagent_stats: { by_type: { "pstack:poteto-agent": 1 } },
    result: CLAIM,
  },
);

test("a recorded /context run yields the init, hook and result fields the checks read", () => {
  const trace = recorded("untouched.S2.context");
  const init = trace.init();
  expect(init.cliVersion).toBe("2.1.332");
  expect(init.plugins[0]).toEqual({ name: "pstack", path: "<STAGE>/plugins/pstack", source: "pstack@inline", version: "0.9.158" });
  expect(init.pluginErrors).toEqual([]);
  expect(init.mcpServers).toEqual([]);
  expect(init.skills).toContain("pstack:poteto-mode");
  expect(init.agents).toContain("pstack:poteto-agent");
  expect(trace.hooks()).toMatchObject([{ name: "SessionStart:startup", event: "SessionStart", exitCode: 0, outcome: "success", stdoutBytes: 983, stderr: "" }]);
  expect(trace.result()).toMatchObject({ subtype: "success", isError: false, costUsd: 0, turns: 0, models: [] });
  expect(trace.models()).toEqual([]);
  expect(trace.malformed).toBe(0);
});

test("a recorded loader error is read with its type", () => {
  expect(recorded("dependency-unsatisfied.S2.context").init().pluginErrors).toMatchObject([{ plugin: "pstack@inline", type: "dependency-unsatisfied" }]);
});

test("a recorded hook failure is read with its exit code and stderr", () => {
  expect(recorded("hook-not-executable.S3.startup").hooks()).toMatchObject([{ exitCode: 126, outcome: "error", stdoutBytes: 0, stderr: "/bin/sh: <STAGE>/plugins/pstack/hooks/session-start.sh: Permission denied\n" }]);
});

test("the result text of a run that called no model is the local command's output", () => {
  expect(recorded("untouched.S2.context").resultText()).toStartWith("## Context Usage");
});

test("tool uses, tool results, user events and replays come out as structured records", () => {
  const trace = readTrace(modelRun);
  expect(trace.toolUses()).toEqual([{ id: "toolu_01", name: "Skill", input: { skill: "pstack:bro" }, parentToolUseId: null }]);
  expect(trace.toolResults()).toEqual([
    { toolUseId: "toolu_01", isError: false, text: "Launching skill: pstack:bro" },
    { toolUseId: "toolu_02", isError: true, text: "Claude requested permissions to write" },
  ]);
  expect(trace.userEvents()).toEqual([
    { text: TYPED, isReplay: true, isSynthetic: false },
    { text: SKILL_BODY, isReplay: false, isSynthetic: true },
  ]);
  expect(trace.replays()).toEqual([{ text: TYPED, isReplay: true, isSynthetic: false }]);
  expect(trace.result()).toEqual({
    subtype: "success",
    isError: false,
    costUsd: 0.0028,
    turns: 3,
    models: ["claude-haiku-5-5"],
    permissionDenials: [{ tool: "Write", input: { file_path: "probe-note.txt" } }],
    subagentsByType: { "pstack:poteto-agent": 1 },
  });
  expect(trace.models()).toEqual(["claude-haiku-5-5"]);
});

// A model can say it ran a skill with the Skill tool disallowed, so its
// words must not be reachable from a check.
test("no accessor returns what a model wrote", () => {
  const trace = readTrace(modelRun, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: CLAIM }] } })}\n`);
  expect(() => trace.resultText()).toThrow("the result text is offered only for a trace that cost nothing and called no model");
  const offered = Object.entries(trace)
    .filter(([name, value]) => typeof value === "function" && name !== "resultText")
    .map(([, accessor]) => accessor());
  expect(offered.length).toBeGreaterThanOrEqual(9);
  expect(JSON.stringify(offered)).not.toContain(CLAIM);
});

test("a billed model with a cost of 0 still closes the result text", () => {
  const free = stream({ type: "result", total_cost_usd: 0, modelUsage: { "claude-haiku-5-5": {} }, result: CLAIM });
  expect(() => readTrace(free).resultText()).toThrow();
});

test("transcript lines carry the hook's duration, and text for user lines only", () => {
  const transcript = stream(
    { type: "attachment", attachment: { type: "hook_success", hookName: "SessionStart:startup", exitCode: 0, durationMs: 228 } },
    { type: "user", isMeta: true, message: { role: "user", content: SKILL_BODY } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: CLAIM }] } },
  );
  expect(readTrace("", transcript).transcriptLines()).toEqual([
    { type: "attachment", attachment: "hook_success", hookName: "SessionStart:startup", durationMs: 228, isMeta: false, text: null },
    { type: "user", attachment: null, hookName: null, durationMs: null, isMeta: true, text: SKILL_BODY },
    { type: "assistant", attachment: null, hookName: null, durationMs: null, isMeta: false, text: null },
  ]);
});

test("a line that is not JSON is counted, not dropped in silence", () => {
  const trace = readTrace(`${stream({ type: "system", subtype: "init" })}{"type":"resu`);
  expect(trace.malformed).toBe(1);
  expect(trace.init()).not.toBeNull();
  expect(trace.result()).toBeNull();
  expect(trace.resultText()).toBeNull();
});

// The exit code and the signal are in the sidecar and stay there. How the
// session ended is handed on for observations: its first line of stderr,
// whether the driver stopped it, whether it started at all.
test("a run is read without its exit code, and with how it ended", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "context.jsonl"), stream({ type: "system", subtype: "init" }));
  writeFileSync(join(dir, "context.stderr"), "error: unknown option '--plugin-dir'\nsecond line\n");
  writeFileSync(join(dir, "context.sidecar.json"), JSON.stringify({ argv: ["claude", "-p"], exit_code: 1, signal: "SIGKILL", timed_out: true, spawn_error: null, trace_sha256: "abc" }));
  const { trace, ...run } = readRun(dir, "context");
  expect(run).toEqual({
    name: "context",
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    recordedSha256: "abc",
    argv: ["claude", "-p"],
    ended: { stderr: "error: unknown option '--plugin-dir'", timedOut: true, spawnError: null },
  });
  expect(trace.init()).not.toBeNull();
});

test("a run with no sidecar and no stderr file is read as one that ended quietly", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "context.jsonl"), "");
  expect(readRun(dir, "context")).toMatchObject({ recordedSha256: null, argv: [], ended: { stderr: "", timedOut: false, spawnError: null } });
});
