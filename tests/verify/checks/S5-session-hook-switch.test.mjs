// Check S5 over its recordings. A doctored trace starts from the untouched
// recording and changes one fact, and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";

const S5 = await shipped("S5");
const MANDATE = "plugins/pstack/hooks/session-start-context.md";
const MANDATE_SHA256 = "39dc6bebcc7b50e6add4b28d470b2faf9f34391fad1bf847039bbe76f26e84e4";

afterEach(cleanup);

const judge = async (edits) => (await check(evidence(S5, edits), S5.checks)).checks.find((each) => each.id === "S5");
const hook = (events) => events.find((event) => event.subtype === "hook_response");
const said = (judged, id) => {
  const item = judged.assertions.find((each) => each.id === id);
  return `saw ${item.saw}, want ${item.want}`;
};

test("the untouched tree passes, and its row tells the control's mandate from the two silences", async () => {
  const result = await check(evidence(S5), S5.checks);
  expect(result.checks.find((each) => each.id === "S5")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  const ran = "1 hook_response named SessionStart:startup; exit_code 0; outcome success";
  expect(markdown(result).split("\n").find((line) => line.startsWith("| S5 "))).toBe(
    `| S5 the session hook switches turn the mandate off | pass | ${ran}; stdout sha256 ${MANDATE_SHA256} (983 bytes); ${ran}; stdout sha256 ${MANDATE_SHA256} (983 bytes); ${ran}; stdout 0 bytes; ${ran}; stdout 0 bytes; 56 of 56 integrity rules hold |`,
  );
});

// Recordings of the real CLI over a tree with the switch broken.
describe("recorded failures", () => {
  test("a hook that stopped reading PSTACK_SESSION_HOOK fails env-off-silent alone", async () => {
    const judged = await judge({ "S5.env-off": { fixture: "env-switch-ignored.S5.env-off" } });
    expect(judged.failed).toEqual(["S5.env-off-silent"]);
    expect(said(judged, "env-off-silent")).toBe("saw stdout 983 bytes, want stdout of 0 bytes");
  });

  test("a hook that treats any value of PSTACK_SESSION_HOOK as off fails env-on-mandate alone", async () => {
    const judged = await judge({ "S5.env-on": { fixture: "any-value-is-off.S5.env-on" } });
    expect(judged.failed).toEqual(["S5.env-on-mandate"]);
    expect(said(judged, "env-on-mandate")).toStartWith("saw stdout sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 (0 bytes), want the stage's hooks/session-start-context.md");
  });

  test("a hook that looks for the sheet in the wrong directory fails sheet-off-silent alone", async () => {
    const judged = await judge({ "S5.sheet-off": { fixture: "sheet-path-moved.S5.sheet-off" } });
    expect(judged.failed).toEqual(["S5.sheet-off-silent"]);
  });

  test("a hook that prints nothing in every case fails the control, so silence elsewhere proves nothing", async () => {
    const judged = await judge({ "S5.control": { fixture: "mandate-never-printed.S5.control" } });
    expect(judged.failed).toEqual(["S5.control-mandate"]);
    expect(said(judged, "control-mandate")).toStartWith("saw stdout sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 (0 bytes), want the stage's hooks/session-start-context.md");
  });
});

describe("one doctored trace per assertion", () => {
  test.each([
    ["S5.control-ran", { "S5.control": { events: (events) => void (hook(events).exit_code = 126) } }],
    ["S5.env-off-ran", { "S5.env-off": { events: (events) => void Object.assign(hook(events), { exit_code: 1, outcome: "error" }) } }],
    ["S5.env-on-ran", { "S5.env-on": { events: (events) => void (hook(events).exit_code = 1) } }],
    ["S5.env-on-mandate", { "S5.env-on": { events: (events) => void (hook(events).stdout += " ") } }],
    ["S5.sheet-off-ran", { "S5.sheet-off": { events: (events) => void (hook(events).stderr = "warning: slow disk\n") } }],
    ["S5.control-mandate", { "S5.control": { events: (events) => void (hook(events).stdout += " ") } }],
  ])("%s fails", async (id, edits) => {
    expect((await judge(edits)).failed).toContain(id);
  });

  // A hook that crashed also prints nothing, so a silent stdout alone is no
  // switch: the run has to have ended well.
  test("a crashed hook is no silence: env-off-ran fails, and so does nothing else of the run", async () => {
    const judged = await judge({ "S5.env-off": { events: (events) => void Object.assign(hook(events), { exit_code: 126, outcome: "error", stderr: "Permission denied\n" }) } });
    expect(judged.failed).toEqual(["S5.env-off-ran"]);
  });

  test("two hook responses in a run fail its ran assertion", async () => {
    const judged = await judge({ "S5.sheet-off": { events: (events) => [hook(events), ...events] } });
    expect(judged.failed).toEqual(["S5.sheet-off-ran"]);
  });

  test("an emptied mandate fails the control", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, MANDATE), "") });
    expect(judged.failed).toEqual(["S5.control-mandate", "S5.env-on-mandate"]);
  });

  test("a mandate file that is gone fails the control and says so", async () => {
    const judged = await judge({ stage: (stage) => rmSync(join(stage, MANDATE)) });
    expect(judged.failed).toEqual(["S5.control-mandate", "S5.env-on-mandate"]);
    expect(said(judged, "control-mandate")).toEndWith("want the stage's hooks/session-start-context.md, which is not there");
  });
});

describe("what a run was given", () => {
  const sessions = (setup, change) => ({ sessions: setup.sessions.map((session) => (session.name === "env-off" ? { ...session, ...change } : session)) });

  test("a switch that setup did not record fails extras", async () => {
    const judged = await judge({ setup: (setup) => sessions(setup, { env: {} }) });
    expect(judged.failed).toEqual(["S5.env-off.extras"]);
  });

  test("a sheet that reached the control fails its extras", async () => {
    const judged = await judge({ setup: (setup) => ({ sessions: setup.sessions.map((session) => (session.name === "control" ? { ...session, files: { "pstack-models.md": "0".repeat(64) } } : session)) }) });
    expect(judged.failed).toEqual(["S5.control.extras"]);
  });

  test("the variable reaching the control's session fails its extras", async () => {
    const judged = await judge({ "S5.control": { sidecar: { env: ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "PSTACK_SESSION_HOOK"] } } });
    expect(judged.failed).toEqual(["S5.control.extras"]);
  });
});

test("a missing trace of one run is unobservable", async () => {
  const judged = await judge({ "S5.sheet-off": { absent: true } });
  expect(judged.verdict).toBe("unobservable");
  expect(judged.reason).toBe("the sheet-off trace is missing");
});
