// Check S3 over its recordings. A doctored trace starts from the untouched
// recording, changes one fact, and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";

const S3 = await shipped("S3");
const MANDATE = "plugins/pstack/hooks/session-start-context.md";
const MANDATE_SHA256 = "39dc6bebcc7b50e6add4b28d470b2faf9f34391fad1bf847039bbe76f26e84e4";
const BROKEN = ["S3.exit-code", "S3.outcome", "S3.stdout", "S3.skills-named", "S3.stderr"];

afterEach(cleanup);

const run = (edits) => check(evidence(S3, edits));
const judge = async (edits) => (await run(edits)).checks.find((each) => each.id === "S3");
const init = (events) => events.find((event) => event.subtype === "init");
const hook = (events) => events.find((event) => event.subtype === "hook_response");
const said = (judged, id) => {
  const item = judged.assertions.find((each) => each.id === id);
  return `saw ${item.saw}, want ${item.want}`;
};

test("the untouched tree passes, and its row quotes the hook's exit code and the digest of its stdout", async () => {
  const result = await run();
  expect(result.checks.find((each) => each.id === "S3")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  expect(markdown(result).split("\n").find((line) => line.startsWith("| S3 "))).toBe(
    `| S3 the mandate arrives at startup | pass | 1 hook_response named SessionStart:startup; SessionStart matcher startup\\|resume\\|clear\\|compact in the stage's hooks.json; exit_code 0; outcome success; stdout sha256 ${MANDATE_SHA256} (983 bytes); 7 pstack: skills named in stdout, each in init.skills; empty stderr; 13 of 13 integrity rules hold |`,
  );
});

describe("recorded failures", () => {
  test("a hook script that lost its executable bit fails on exit_code 126", async () => {
    const judged = await judge({ S3: { fixture: "hook-not-executable.S3.startup" } });
    expect(judged.failed).toEqual(BROKEN);
    expect(said(judged, "exit-code")).toBe("saw exit_code 126, want exit_code 0");
    expect(judged.observations.map((seen) => seen.text)).toEqual([expect.stringMatching(/^hook SessionStart:startup wrote to stderr: \/bin\/sh: .*session-start\.sh: Permission denied$/)]);
  });

  test("a deleted mandate file fails on exit_code 1", async () => {
    const judged = await judge({ stage: (stage) => rmSync(join(stage, MANDATE)), S3: { fixture: "mandate-missing.S3.startup" } });
    expect(judged.failed).toEqual(BROKEN);
    expect(said(judged, "exit-code")).toBe("saw exit_code 1, want exit_code 0");
    expect(said(judged, "stdout")).toEndWith("want the stage's hooks/session-start-context.md, which is not there");
  });
});

describe("a mandate that arrives and routes nowhere", () => {
  // The hook prints the file, so its stdout equals the file whatever the
  // file holds. Emptied, every other assertion still passes.
  test("an emptied mandate fails skills-named alone", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, MANDATE), ""), S3: { events: (events) => void Object.assign(hook(events), { stdout: "", output: "" }) } });
    expect(judged.failed).toEqual(["S3.skills-named"]);
    expect(said(judged, "skills-named")).toBe("saw no pstack: skill named in stdout, want at least 1 pstack: skill named in stdout, each in init.skills");
    expect(said(judged, "stdout")).toStartWith("saw stdout sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 (0 bytes)");
  });

  // A skill directory removed from the tree, or every one of them.
  test("a mandate that names a skill the session did not load fails skills-named alone", async () => {
    const unload = (events) => void (init(events).skills = init(events).skills.filter((name) => name !== "pstack:poteto-mode"));
    const judged = await judge({ S3: { events: unload } });
    expect(judged.failed).toEqual(["S3.skills-named"]);
    expect(said(judged, "skills-named")).toStartWith("saw named in stdout and not in init.skills: pstack:poteto-mode, want ");
  });

  test("with no plugin skill loaded, every skill the mandate names is listed", async () => {
    const gut = (events) => void (init(events).skills = init(events).skills.filter((name) => !name.startsWith("pstack:")));
    const judged = await judge({ S3: { events: gut } });
    expect(said(judged, "skills-named")).toStartWith("saw named in stdout and not in init.skills: pstack:poteto-mode, pstack:tdd, pstack:architect, pstack:how, pstack:why, pstack:arena, pstack:interrogate, want ");
  });
});

// What a startup hook handed to the session from outside the plugin leaves:
// the recorded response, over a tree that registers no hook for startup.
describe("a response the tree cannot have produced", () => {
  const HOOKS = "plugins/pstack/hooks/hooks.json";
  const hooksWith = (matcher) => JSON.stringify({ hooks: { SessionStart: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command: "x" }] }] } });

  test.each([
    ["a matcher that leaves startup out", hooksWith("resume|clear|compact"), "saw SessionStart matcher resume|clear|compact in the stage's hooks.json"],
    ["a hooks file with no SessionStart hook", JSON.stringify({ hooks: {} }), "saw no SessionStart hook in the stage's hooks.json"],
    ["a hooks file that is not JSON", "{ nope", "saw no SessionStart hook in the stage's hooks.json"],
  ])("%s fails registered alone", async (_, hooks, saw) => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, HOOKS), hooks) });
    expect(judged.failed).toEqual(["S3.registered"]);
    expect(said(judged, "registered")).toBe(`${saw}, want a SessionStart hook in the stage's hooks.json whose matcher covers startup`);
  });

  test("no hooks file fails registered alone", async () => {
    expect((await judge({ stage: (stage) => rmSync(join(stage, HOOKS)) })).failed).toEqual(["S3.registered"]);
  });

  test.each([["startup"], ["startup|resume"], ["*"], [""], [undefined], ["start.*"]])("a matcher of %p covers startup", async (matcher) => {
    expect((await judge({ stage: (stage) => writeFileSync(join(stage, HOOKS), hooksWith(matcher)) })).verdict).toBe("pass");
  });
});

describe("one doctored trace per assertion", () => {
  const cases = [
    ["S3.one-response", { S3: { events: (events) => [hook(events), ...events] } }],
    ["S3.exit-code", { S3: { events: (events) => void (hook(events).exit_code = 126) } }],
    ["S3.outcome", { S3: { events: (events) => void (hook(events).outcome = "error") } }],
    ["S3.stdout", { S3: { events: (events) => void (hook(events).stdout += " ") } }],
    ["S3.stderr", { S3: { events: (events) => void (hook(events).stderr = "warning: slow disk\n") } }],
  ];

  test.each(cases)("%s fails alone", async (id, edits) => {
    expect((await judge(edits)).failed).toEqual([id]);
  });
});

test("a trace without the hook response is unobservable", async () => {
  const judged = await judge({ S3: { events: (events) => events.filter((event) => !event.subtype?.startsWith("hook_")) } });
  expect(judged).toMatchObject({ verdict: "unobservable", reason: "a hook_response named SessionStart:startup is missing", failed: [] });
});
