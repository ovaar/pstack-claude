// Check B3 over its recordings: three signed-in sessions asked to use
// pstack:why by name, which loaded it through the Skill tool.
import { afterEach, describe, expect, test } from "bun:test";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";
import { recall, resultBlocks, saidSo } from "../doctor.mjs";

const B3 = await shipped("B3");
afterEach(cleanup);

const run = (edits) => check(evidence(B3, edits));
const judge = async (edits) => (await run(edits)).checks.find((each) => each.id === "B3");
const said = (judged, id) => judged.assertions.find((each) => each.id === id).saw;

test("the recorded sessions pass, each with the Skill call as its first and only call", async () => {
  const result = await run();
  expect(result.checks.find((each) => each.id === "B3")).toMatchObject({ verdict: "pass", failed: [] });
  const row = markdown(result).split("\n").find((line) => line.startsWith("| B3 "));
  expect(row.split("Skill pstack:why was call 1 of 1, and it loaded").length - 1).toBe(3);
});

describe("what counts as loading it", () => {
  test("a session that says it used the skill, with no call, fails the pass rule", async () => {
    const judged = await judge({ B3: { events: (events) => saidSo(events, "I used the pstack:why skill.") } });
    expect(judged.failed).toEqual(["B3.pass-rule"]);
    expect(said(judged, "attempt-1")).toBe("no Skill call for pstack:why in 0 calls");
  });

  test("a Skill call that came back as an error did not load it", async () => {
    const judged = await judge({ B3: { events: (events) => void resultBlocks(events).forEach((block) => (block.is_error = true)) } });
    expect(judged.failed).toEqual(["B3.pass-rule"]);
    expect(said(judged, "attempt-1")).toBe("Skill pstack:why was call 1 of 1, and it did not load");
  });

  test("another skill is not it", async () => {
    const judged = await judge({ B3: { events: (events) => recall(events, (block) => (block.name === "Skill" ? (block.input.skill = "pstack:how") : null)) } });
    expect(judged.failed).toEqual(["B3.pass-rule"]);
    expect(said(judged, "attempt-3")).toBe("no Skill call for pstack:why in 1 calls (Skill pstack:how)");
  });

  test("the rule is 2 of 3", async () => {
    const out = { events: (events) => saidSo(events, "no") };
    expect((await judge({ "B3.attempt-1": out })).verdict).toBe("pass");
    expect((await judge({ "B3.attempt-1": out, "B3.attempt-2": out })).failed).toEqual(["B3.pass-rule"]);
  });
});
