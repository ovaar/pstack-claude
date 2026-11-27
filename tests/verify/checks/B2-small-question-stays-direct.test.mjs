// Check B2 over its recordings: three signed-in sessions that answered a
// one-line question with the mandate in place and no detour. A doctored trace
// changes one fact and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";
import { firstCall, hookResponse, lastResult, recall } from "../doctor.mjs";

const B2 = await shipped("B2");
afterEach(cleanup);

const run = (edits) => check(evidence(B2, edits));
const judge = async (edits) => (await run(edits)).checks.find((each) => each.id === "B2");
const said = (judged, id) => judged.assertions.find((each) => each.id === id).saw;
// The session reaches for the mandate's own skill before it answers.
const detour = { events: (events) => firstCall(events, "Skill", { skill: "pstack:poteto-mode", args: "which git command" }) };

test("the recorded sessions pass, with no call at all in any attempt", async () => {
  const result = await run();
  expect(result.checks.find((each) => each.id === "B2")).toMatchObject({ verdict: "pass", failed: [] });
  const row = markdown(result).split("\n").find((line) => line.startsWith("| B2 "));
  expect(row.split("0 calls, none for pstack:poteto-mode").length - 1).toBe(3);
  expect(row).toContain("3 of 3 attempts direct");
});

describe("what routes a question is a Skill call for poteto-mode", () => {
  test("a session that detours through it in every attempt fails the pass rule", async () => {
    const judged = await judge({ B2: detour });
    expect(judged.failed).toEqual(["B2.pass-rule"]);
    expect(said(judged, "attempt-1")).toBe("Skill pstack:poteto-mode as call 1 of 1");
    expect(said(judged, "pass-rule")).toBe("0 of 3 attempts direct");
  });

  test("one detour in three still passes, and two fail", async () => {
    expect((await judge({ "B2.attempt-1": detour })).verdict).toBe("pass");
    expect((await judge({ "B2.attempt-1": detour, "B2.attempt-2": detour })).failed).toEqual(["B2.pass-rule"]);
  });

  test("another tool call is not a detour", async () => {
    const bash = { events: (events) => firstCall(events, "Bash", { command: "git show --name-only HEAD" }) };
    const judged = await judge({ B2: bash });
    expect(judged.verdict).toBe("pass");
    expect(said(judged, "attempt-1")).toBe("1 calls (Bash), none for pstack:poteto-mode");
  });

  test("a different skill is not a detour", async () => {
    const other = { events: (events) => recall(firstCall(events, "Skill", { skill: "pstack:how" }), () => {}) };
    expect((await judge({ B2: other })).verdict).toBe("pass");
  });
});

// A direct answer proves the session held back only where it was tempted.
test("with no mandate, a direct answer proves nothing: mandate-arrived fails", async () => {
  const judged = await judge({ B2: { events: (events) => void Object.assign(hookResponse(events), { stdout: "", output: "" }) } });
  expect(judged.failed).toEqual(["B2.mandate-arrived"]);
});

test("a session that stopped on an API error fails ended-normally", async () => {
  const judged = await judge({ "B2.attempt-2": { events: (events) => void Object.assign(lastResult(events), { subtype: "error_during_execution" }) } });
  expect(judged.failed).toEqual(["B2.ended-normally"]);
});

test("a session that called no model is not a direct answer: it fails billed", async () => {
  const judged = await judge({ "B2.attempt-3": { events: (events) => void (lastResult(events).total_cost_usd = 0) } });
  expect(judged.failed).toEqual(["B2.attempt-3.billed"]);
});
