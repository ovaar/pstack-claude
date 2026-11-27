// Check B4 over its recordings: two signed-in sessions that were sent a typed
// /pstack:how. The harness replayed the command, and the model handed the
// skill's brief to a subagent. A doctored trace changes one fact and must
// turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";
import { saidSo, toolUses } from "../doctor.mjs";

const B4 = await shipped("B4");
const HOW = "plugins/pstack/skills/how/SKILL.md";
afterEach(cleanup);

const run = (edits) => check(evidence(B4, edits));
const judge = async (edits) => (await run(edits)).checks.find((each) => each.id === "B4");
const said = (judged, id) => judged.assertions.find((each) => each.id === id).saw;
const replay = (events) => events.find((event) => event.isReplay);

test("the recorded sessions pass: the command was replayed, and the brief reached a subagent", async () => {
  const result = await run();
  expect(result.checks.find((each) => each.id === "B4")).toMatchObject({ verdict: "pass", failed: [] });
  const row = markdown(result).split("\n").find((line) => line.startsWith("| B4 "));
  expect(row).toContain("Agent call 1 of ");
  expect(row).toContain("subagent_type general-purpose, with the brief in its prompt");
  expect(row).toContain("2 of 2 attempts carried the brief to a subagent");
});

describe("the harness half holds every time", () => {
  test("a command that was not replayed as a command fails command-resolved", async () => {
    const judged = await judge({ B4: { events: (events) => void (replay(events).message.content = "/pstack:does-not-exist") } });
    expect(judged.failed).toEqual(["B4.command-resolved"]);
    expect(said(judged, "command-resolved")).toBe("no replayed command; no replayed command");
  });
});

describe("the model half is sampled, 1 of 2", () => {
  const nothing = { events: (events) => saidSo(events, "Here is how order_total works.") };

  test("a session that answered itself, with no dispatch, misses", async () => {
    const judged = await judge({ "B4.attempt-1": nothing });
    expect(judged.verdict).toBe("pass");
    expect(said(judged, "attempt-1")).toBe("0 calls, none carrying the brief");
    expect(said(judged, "pass-rule")).toBe("1 of 2 attempts carried the brief to a subagent");
  });

  test("two misses fail the rule", async () => {
    const judged = await judge({ B4: nothing });
    expect(judged.failed).toEqual(["B4.pass-rule"]);
  });

  test("a dispatch whose prompt lacks the brief is not the skill", async () => {
    const own = { events: (events) => void toolUses(events).forEach((block) => block.name === "Agent" && (block.input.prompt = "Explain order_total.")) };
    expect((await judge({ B4: own })).failed).toEqual(["B4.pass-rule"]);
  });

  test("a brief the stage's skill no longer holds is not found in the prompt", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, HOW), "> You are writing an entirely different brief.\n") });
    expect(judged.failed).toContain("B4.pass-rule");
  });

  test("with no brief in the stage's skill, the check is unobservable, not passed", async () => {
    const judged = await judge({ stage: (stage) => rmSync(join(stage, HOW)) });
    expect(judged).toMatchObject({ verdict: "unobservable" });
    expect(judged.reason).toStartWith("the subagent brief in the stage's plugins/pstack/skills/how/SKILL.md is missing");
  });
});
