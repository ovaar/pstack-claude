// Check B1 over its recordings: three signed-in sessions in which the mandate
// routed a multi-file bug to pstack:poteto-mode. A doctored trace starts from
// those recordings, changes one fact, and must turn the assertion that guards
// it. The recordings were made with the CLI the checks are verified on.
import { afterEach, describe, expect, test } from "bun:test";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";
import { firstCall, hookResponse, lastResult, recall, refused, resultBlocks, saidSo } from "../doctor.mjs";

const B1 = await shipped("B1");
afterEach(cleanup);

const run = (edits) => check(evidence(B1, edits));
const judge = async (edits) => (await run(edits)).checks.find((each) => each.id === "B1");
const said = (judged, id) => judged.assertions.find((each) => each.id === id).saw;
const ATTEMPTS = ["attempt-1", "attempt-2", "attempt-3"];
const everyAttempt = (edit) => Object.fromEntries(ATTEMPTS.map((name) => [`B1.${name}`, edit]));
// The CLI says one thing when a skill loads, and the session continues; a
// skill that cannot be loaded comes back as an error.
const said_so = { events: (events) => saidSo(events, "I ran the pstack:poteto-mode skill with the Skill tool.") };

test("the recorded sessions pass, and every attempt is in the evidence row", async () => {
  const result = await run();
  expect(result.checks.find((each) => each.id === "B1")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  const row = markdown(result).split("\n").find((line) => line.startsWith("| B1 "));
  expect(row.split("Skill pstack:poteto-mode was call 1 of 1, and it loaded; first Edit or Write: none").length - 1).toBe(ATTEMPTS.length);
  expect(row).toContain("3 of 3 attempts routed");
  expect(result.line).toMatch(/behavior 1\/5 \(3 model calls, \$0\.00\d+\)/);
});

describe("what the check does not take for a call", () => {
  // The old text match, SKILL-RAN, would pass this trace.
  test("a session that says it ran the skill, with no call, fails the pass rule", async () => {
    const judged = await judge({ B1: said_so });
    expect(judged.failed).toEqual(["B1.pass-rule"]);
    expect(said(judged, "attempt-1")).toBe("no Skill call for pstack:poteto-mode in 0 calls; first Edit or Write: none");
    expect(said(judged, "pass-rule")).toBe("0 of 3 attempts routed");
  });

  // The process exits 0 and the stream ends in an ordinary result, so only
  // the tool_result's own flag shows that no skill loaded.
  test("a Skill call that came back as an error is not routing, whatever the exit code", async () => {
    const judged = await judge({ B1: { events: (events) => void resultBlocks(events).forEach((block) => (block.is_error = true)) } });
    expect(judged.failed).toEqual(["B1.pass-rule"]);
    expect(said(judged, "attempt-2")).toStartWith("Skill pstack:poteto-mode was call 1 of 1, and it did not load");
  });

  test("a different skill is not routing", async () => {
    const judged = await judge({ B1: { events: (events) => recall(events, (block) => (block.name === "Skill" ? (block.input.skill = "pstack:why") : null)) } });
    expect(judged.failed).toEqual(["B1.pass-rule"]);
  });

  test("an Edit before the Skill call is not routing", async () => {
    const judged = await judge({ B1: { events: (events) => firstCall(events, "Edit", { file_path: "cart.py", old_string: "1.21", new_string: "1.2" }) } });
    expect(judged.failed).toEqual(["B1.pass-rule"]);
    expect(said(judged, "attempt-1")).toBe("Skill pstack:poteto-mode was call 2 of 2, and it loaded; first Edit or Write: call 1");
  });

  test("a Write before the Skill call is not routing either", async () => {
    const judged = await judge({ B1: { events: (events) => firstCall(events, "Write", { file_path: "notes.md", content: "x" }) } });
    expect(judged.failed).toEqual(["B1.pass-rule"]);
  });

  test("a call a subagent made is not the session's own", async () => {
    const own = (events) => firstCall(events, "Edit", { file_path: "cart.py" }).map((event) => (event.message?.id === "msg_first_call" ? { ...event, parent_tool_use_id: "toolu_elsewhere" } : event));
    expect((await judge({ B1: { events: own } })).verdict).toBe("pass");
  });
});

describe("the pass rule is 2 of 3", () => {
  const out = { events: (events) => saidSo(events, "no routing here") };

  test("one attempt that missed still passes, and its row says what it saw", async () => {
    const judged = await judge({ "B1.attempt-2": out });
    expect(judged.verdict).toBe("pass");
    expect(said(judged, "attempt-2")).toBe("no Skill call for pstack:poteto-mode in 0 calls; first Edit or Write: none");
    expect(markdown(await run({ "B1.attempt-2": out }))).toContain("no Skill call for pstack:poteto-mode in 0 calls; first Edit or Write: none");
    expect(said(judged, "pass-rule")).toBe("2 of 3 attempts routed");
  });

  test("two that missed fail it", async () => {
    const judged = await judge({ "B1.attempt-1": out, "B1.attempt-3": out });
    expect(judged.failed).toEqual(["B1.pass-rule"]);
    // The row of a failed check carries every attempt, the routed one too.
    const row = markdown(await run({ "B1.attempt-1": out, "B1.attempt-3": out })).split("\n").find((line) => line.startsWith("| B1 "));
    expect(row).toContain("attempt-2: saw Skill pstack:poteto-mode was call 1 of 1, and it loaded");
    expect(row).toContain("pass-rule: saw 1 of 3 attempts routed, want at least 2 of 3 attempts routed");
  });
});

describe("the conditions of the sample", () => {
  test("a session that never had the mandate fails mandate-arrived, not only the rule", async () => {
    const judged = await judge(everyAttempt({ events: (events) => void Object.assign(hookResponse(events), { stdout: "", output: "" }) }));
    expect(judged.failed).toContain("B1.mandate-arrived");
    expect(said(judged, "mandate-arrived")).toBe("exit_code 0, 0 bytes; exit_code 0, 0 bytes; exit_code 0, 0 bytes");
  });

  test("a hook that failed fails mandate-arrived", async () => {
    const judged = await judge({ "B1.attempt-1": { events: (events) => void Object.assign(hookResponse(events), { exit_code: 126 }) } });
    expect(judged.failed).toEqual(["B1.mandate-arrived"]);
  });

  test("a session that stopped for its budget, not its turns, fails ended-normally", async () => {
    const judged = await judge({ "B1.attempt-3": { events: (events) => void (lastResult(events).subtype = "error_max_budget_usd") } });
    expect(judged.failed).toEqual(["B1.ended-normally"]);
    expect(said(judged, "ended-normally")).toBe("result subtypes error_max_turns, error_max_turns, error_max_budget_usd");
  });

  test("a trace with no hook response is unobservable", async () => {
    const judged = await judge({ "B1.attempt-1": { events: (events) => events.filter((event) => !event.subtype?.startsWith("hook_")) } });
    expect(judged).toMatchObject({ verdict: "unobservable", reason: "a hook_response named SessionStart:startup is missing" });
  });
});

describe("the integrity rules of a session that called a model", () => {
  test("a signed-out session, which called no model, fails billed and real-model", async () => {
    const judged = await judge({ "B1.attempt-1": { events: (events) => refused(events, null) } });
    expect(judged.verdict).toBe("fail");
    expect(judged.failed).toEqual(expect.arrayContaining(["B1.attempt-1.billed", "B1.attempt-1.real-model"]));
  });

  test("a tool result with no call in the stream fails tool-results", async () => {
    const judged = await judge({ "B1.attempt-1": { events: (events) => void resultBlocks(events).forEach((block) => (block.tool_use_id = "toolu_nobody_made_this")) } });
    expect(judged.failed).toContain("B1.attempt-1.tool-results");
  });

  test("a cost of 0 on a session that says it called a model fails billed", async () => {
    const judged = await judge({ "B1.attempt-1": { events: (events) => void (lastResult(events).total_cost_usd = 0) } });
    expect(judged.failed).toContain("B1.attempt-1.billed");
  });

  test("a session with no real model id fails real-model", async () => {
    const judged = await judge({
      "B1.attempt-1": {
        events: (events) => {
          lastResult(events).modelUsage = {};
          for (const event of events) if (event.type === "assistant") event.message.model = "<synthetic>";
        },
      },
    });
    expect(judged.failed).toContain("B1.attempt-1.real-model");
  });

  test("an argument the check does not declare, such as a larger budget, fails argv", async () => {
    const judged = await judge({ "B1.attempt-1": { argv: (argv) => argv.map((arg) => (arg === "0.03" ? "5" : arg)) } });
    expect(judged.failed).toEqual(["B1.attempt-1.argv"]);
  });

  test("a different prompt fails argv", async () => {
    const judged = await judge({ "B1.attempt-2": { argv: (argv) => [...argv.slice(0, -1), "Fix the bug."] } });
    expect(judged.failed).toEqual(["B1.attempt-2.argv"]);
  });
});

describe("a key the API refused", () => {
  test("is an error that says so, and not a skipped tier or a failed plugin", async () => {
    const result = await run(everyAttempt({ events: (events) => refused(events) }));
    const judged = result.checks.find((each) => each.id === "B1");
    expect(judged.verdict).toBe("error");
    expect(judged.reason).toStartWith("credential present but rejected");
    expect(result.verdict).toBe("FAIL");
  });
});
