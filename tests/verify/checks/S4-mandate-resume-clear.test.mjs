// Check S4 over its recordings. A doctored trace or tree starts from the
// untouched one, changes one fact, and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";

const S4 = await shipped("S4");
const HOOKS = "plugins/pstack/hooks/hooks.json";
const MANDATE = "plugins/pstack/hooks/session-start-context.md";
const MANDATE_SHA256 = "39dc6bebcc7b50e6add4b28d470b2faf9f34391fad1bf847039bbe76f26e84e4";
const SOURCES = ["startup", "resume", "clear", "compact"];

afterEach(cleanup);

const judge = async (edits) => (await check(evidence(S4, edits), S4.checks)).checks.find((each) => each.id === "S4");
const hook = (events, source) => events.find((event) => event.subtype === "hook_response" && event.hook_name === `SessionStart:${source}`);
const said = (judged, id) => {
  const item = judged.assertions.find((each) => each.id === id);
  return `saw ${item.saw}, want ${item.want}`;
};
// The tree's hooks.json with the SessionStart matcher given.
const matcher = (value) => (stage) =>
  writeFileSync(join(stage, HOOKS), JSON.stringify({ hooks: { SessionStart: [{ ...(value === undefined ? {} : { matcher: value }), hooks: [{ type: "command", command: "x" }] }] } }));

test("the untouched tree passes, and its row quotes the mandate's digest for both sources", async () => {
  const result = await check(evidence(S4), S4.checks);
  expect(result.checks.find((each) => each.id === "S4")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  const arrived = (source) => `1 hook_response named SessionStart:${source}; exit_code 0; outcome success; stdout sha256 ${MANDATE_SHA256} (983 bytes); empty stderr`;
  expect(markdown(result).split("\n").find((line) => line.startsWith("| S4 "))).toBe(
    `| S4 the mandate arrives on resume and clear | pass | SessionStart matcher startup\\|resume\\|clear\\|compact; ${arrived("clear")}; ${arrived("resume")}; 28 of 28 integrity rules hold |`,
  );
});

// Recordings of the real CLI over a tree with one mistake. The hooks.json of
// the tree it was recorded over is written as the test's stage.
describe("recorded failures", () => {
  test("a matcher without resume, af7aa63: no hook runs on resume, and registered says which source is left out", async () => {
    const judged = await judge({ stage: matcher("startup|clear|compact"), "S4.resume": { fixture: "matcher-without-resume.S4.resume" } });
    expect(judged.failed).toEqual(["S4.registered", "S4.resume-one-response", "S4.resume-exit-code", "S4.resume-outcome", "S4.resume-stdout", "S4.resume-stderr"]);
    expect(said(judged, "registered")).toStartWith("saw SessionStart matcher startup|clear|compact, which leaves out resume, want ");
    expect(said(judged, "resume-one-response")).toBe("saw 0 hook_response named SessionStart:resume, want exactly 1");
  });

  test("a matcher without clear leaves clear's hook out, and the resume still passes", async () => {
    const judged = await judge({ stage: matcher("startup|resume|compact"), "S4.clear": { fixture: "matcher-without-clear.S4.clear" } });
    expect(judged.failed.every((id) => id === "S4.registered" || id.startsWith("S4.clear-"))).toBe(true);
    expect(judged.failed).toContain("S4.clear-one-response");
  });

  test("a hook that prints nothing unless the source is startup fails stdout on both sources and nothing else", async () => {
    const judged = await judge({ "S4.clear": { fixture: "startup-only-hook.S4.clear" }, "S4.resume": { fixture: "startup-only-hook.S4.resume" } });
    expect(judged.failed).toEqual(["S4.clear-stdout", "S4.resume-stdout"]);
    expect(said(judged, "resume-stdout")).toStartWith("saw stdout sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 (0 bytes), want the stage's hooks/session-start-context.md");
  });
});

// Compact cannot be driven with no model call, so the matcher is all that
// guards it, and any source the matcher leaves out fails registered alone.
describe("the registered matcher", () => {
  test.each(SOURCES)("a matcher without %s fails registered alone", async (source) => {
    const narrowed = SOURCES.filter((each) => each !== source).join("|");
    const judged = await judge({ stage: matcher(narrowed) });
    expect(judged.failed).toEqual(["S4.registered"]);
    expect(said(judged, "registered")).toStartWith(`saw SessionStart matcher ${narrowed}, which leaves out ${source}, want `);
  });

  test.each([["startup"], ["startup|resume"], ["clear"], ["resume|clear"]])("a matcher of %p leaves sources out", async (value) => {
    expect((await judge({ stage: matcher(value) })).failed).toEqual(["S4.registered"]);
  });

  test.each([["startup|resume|clear|compact"], ["*"], [""], [undefined], [".*"], ["startup|resume|clear|compact|other"]])("a matcher of %p covers all four", async (value) => {
    expect((await judge({ stage: matcher(value) })).verdict).toBe("pass");
  });

  test("two hooks that together cover the four sources pass", async () => {
    const hooks = { hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [] }, { matcher: "clear|compact", hooks: [] }] } };
    expect((await judge({ stage: (stage) => writeFileSync(join(stage, HOOKS), JSON.stringify(hooks)) })).verdict).toBe("pass");
  });

  test("a hooks file with no SessionStart hook, one that is not JSON and none at all fail registered alone", async () => {
    for (const stage of [(s) => writeFileSync(join(s, HOOKS), JSON.stringify({ hooks: {} })), (s) => writeFileSync(join(s, HOOKS), "{ nope"), (s) => rmSync(join(s, HOOKS))]) {
      const judged = await judge({ stage });
      expect(judged.failed).toEqual(["S4.registered"]);
      expect(said(judged, "registered")).toStartWith("saw no SessionStart hook in the stage's hooks.json");
    }
  });
});

describe("one doctored trace per assertion", () => {
  test.each(["clear", "resume"])("%s: each assertion fails alone", async (source) => {
    const run = `S4.${source}`;
    const changes = [
      [`S4.${source}-one-response`, (events) => [hook(events, source), ...events]],
      [`S4.${source}-exit-code`, (events) => void (hook(events, source).exit_code = 126)],
      [`S4.${source}-outcome`, (events) => void (hook(events, source).outcome = "error")],
      [`S4.${source}-stdout`, (events) => void (hook(events, source).stdout += " ")],
      [`S4.${source}-stderr`, (events) => void (hook(events, source).stderr = "warning: slow disk\n")],
    ];
    for (const [id, events] of changes) expect((await judge({ [run]: { events } })).failed).toEqual([id]);
  });

  test("a response under the wrong source name is no response for the source", async () => {
    const rename = (events) => void (hook(events, "resume").hook_name = "SessionStart:startup");
    const judged = await judge({ "S4.resume": { events: rename } });
    expect(judged.failed).toContain("S4.resume-one-response");
  });

  test("an emptied mandate fails both stdout assertions", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, MANDATE), "") });
    expect(judged.failed).toEqual(["S4.clear-stdout", "S4.resume-stdout"].map((id) => id));
  });
});

test("a missing trace of the resume run is unobservable", async () => {
  const judged = await judge({ "S4.resume": { absent: true } });
  expect(judged.verdict).toBe("unobservable");
  expect(judged.reason).toBe("the resume trace is missing");
});
