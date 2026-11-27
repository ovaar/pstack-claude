// Check B5 over its recordings: B1's prompt with the session hook off. The
// hook ran and printed nothing, and the sessions did not route. A doctored
// trace changes one fact and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";
import { firstCall, hookResponse } from "../doctor.mjs";

const B5 = await shipped("B5");
afterEach(cleanup);

const run = (edits) => check(evidence(B5, edits));
const judge = async (edits) => (await run(edits)).checks.find((each) => each.id === "B5");
const said = (judged, id) => judged.assertions.find((each) => each.id === id).saw;
const routes = { events: (events) => firstCall(events, "Skill", { skill: "pstack:poteto-mode", args: "Bug" }) };

test("the recorded sessions pass: a silent hook, and none of the three routed", async () => {
  const result = await run();
  expect(result.checks.find((each) => each.id === "B5")).toMatchObject({ verdict: "pass", failed: [] });
  const row = markdown(result).split("\n").find((line) => line.startsWith("| B5 "));
  expect(row).toContain("exit_code 0, 0 bytes; exit_code 0, 0 bytes; exit_code 0, 0 bytes");
  expect(row).toContain("3 of 3 attempts unrouted");
});

describe("a session that routed with the hook off", () => {
  test("in every attempt fails the pass rule, and the mandate is not what routed it", async () => {
    const judged = await judge({ B5: routes });
    expect(judged.failed).toEqual(["B5.pass-rule"]);
    expect(said(judged, "attempt-1")).toMatch(/^Skill pstack:poteto-mode as call 1 of \d+$/);
  });

  test("in one attempt of three still passes, and in two fails", async () => {
    expect((await judge({ "B5.attempt-1": routes })).verdict).toBe("pass");
    expect((await judge({ "B5.attempt-1": routes, "B5.attempt-3": routes })).failed).toEqual(["B5.pass-rule"]);
  });
});

// The condition is the point: if the hook had printed the mandate, a session
// that did not route would say nothing about the mandate's effect.
describe("the hook must have been off", () => {
  test("a mandate on stdout in any attempt fails hook-off", async () => {
    const judged = await judge({ "B5.attempt-2": { events: (events) => void Object.assign(hookResponse(events), { stdout: "<EXTREMELY_IMPORTANT>You have pstack.</EXTREMELY_IMPORTANT>" }) } });
    expect(judged.failed).toEqual(["B5.hook-off"]);
    expect(said(judged, "hook-off")).toBe("exit_code 0, 0 bytes; exit_code 0, 59 bytes; exit_code 0, 0 bytes");
  });

  test("a hook that failed is not an off hook", async () => {
    const judged = await judge({ "B5.attempt-1": { events: (events) => void Object.assign(hookResponse(events), { exit_code: 1 }) } });
    expect(judged.failed).toEqual(["B5.hook-off"]);
  });
});

test("a session that did not run to the end fails ended-normally", async () => {
  const judged = await judge({ "B5.attempt-1": { events: (events) => void (events.find((event) => event.type === "result").subtype = "error_max_budget_usd") } });
  expect(judged.failed).toEqual(["B5.ended-normally"]);
});
