// Check S6 over its recordings. A doctored trace starts from the untouched
// recording and changes one fact, and must turn the assertion that guards it.
// The recordings are of the real CLI over this tree's 68 skills, 44 of which
// a user can invoke, reduced by tests/verify/scrub.mjs to what trace.mjs reads.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { FLOWS_DIR, loadDir } from "../../../tools/verify/paths.mjs";
import { plan } from "../../../tools/verify/setup.mjs";
import { cleanup, evidence, fixtureStage, shipped, tempDir } from "../harness.mjs";

const S6 = await shipped("S6");
const LEAF = "plugins/pstack/skills/principle-prove-it-works/SKILL.md";

afterEach(cleanup);

const judge = async (edits) => (await check(evidence(S6, edits), S6.checks)).checks.find((each) => each.id === "S6");
const said = (judged, id) => {
  const item = judged.assertions.find((each) => each.id === id);
  return `saw ${item.saw}, want ${item.want}`;
};
const replayOf = (events, name) => events.find((event) => event.isReplay && event.message.content.includes(`/pstack:${name}`));
const refusals = (events) => events.filter((event) => event.type === "result" && String(event.result).startsWith("This skill can only be invoked by Claude"));
const lines = (text) => text.trimEnd().split("\n").map((line) => JSON.parse(line));
const text = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");
const transcript = (change) => (original) => text(change(lines(original)));
const meta = (name) => (record) => record.isMeta && record.message.content[0]?.text?.endsWith(`/skills/${name}`);
const expandedBy = (name) => meta(name);

test("the untouched tree passes, and its row counts what was typed and how each came out", async () => {
  const result = await check(evidence(S6), S6.checks);
  expect(result.checks.find((each) => each.id === "S6")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  expect(markdown(result).split("\n").find((line) => line.startsWith("| S6 "))).toBe(
    "| S6 a typed slash command is resolved before any model call | pass | 69 results for the messages typed; 44 skills echoed as a command; 44 skills expanded from the stage; 24 refusals (turns 0); 24 of 24 hidden skills typed; 24 hidden skills, each a principle-* skill; 24 principle-* skills, none invocable by a user; 1 replays of /pstack:does-not-exist as typed; 1 unknown_command_fallback in the transcript; no skill of the tree passed on as typed; 14 of 14 integrity rules hold |",
  );
});

// Recordings of the real CLI over a tree with one mistake. The stream of the
// first is byte for byte the untouched one: only the transcript tells it.
describe("recorded failures", () => {
  test("a command file beside a skill, c42e947, is echoed like the skill and not expanded, so only expanded fails", async () => {
    const judged = await judge({ S6: { fixture: "command-trampoline.S6.typed" } });
    expect(judged.failed).toEqual(["S6.expanded"]);
    expect(said(judged, "expanded")).toStartWith("saw skills expanded from the stage: 1 lacking (bro); 0 not the tree's (none); 0 twice (none), want ");
  });

  test("a principle leaf that a user can invoke, 5debf23, is expanded and fails leaves-refused alone", async () => {
    const judged = await judge({
      stage: (stage) => writeFileSync(join(stage, LEAF), "---\nname: principle-prove-it-works\n---\n"),
      S6: { fixture: "leaf-public.S6.typed" },
    });
    expect(judged.failed).toEqual(["S6.leaves-refused"]);
    expect(said(judged, "leaves-refused")).toStartWith("saw a user can invoke 1 of 24 principle-* skills: principle-prove-it-works, want ");
  });
});

describe("a public skill made hidden", () => {
  // The tree and the session agree about it, as they do when the file is what
  // changed: the hidden skill is refused, and so only the rule that names the
  // hidden ones can fail. The recording is the untouched tree's, so the
  // skill's echo and expansion in it are what also fail.
  test("a command skill that gained user-invocable: false fails only-leaves-hidden", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, "plugins/pstack/skills/bro/SKILL.md"), "---\nname: bro\nuser-invocable: false\n---\nText.\n") });
    expect(judged.failed).toContain("S6.only-leaves-hidden");
    expect(said(judged, "only-leaves-hidden")).toStartWith("saw hidden from users and no principle-* skill: bro, want ");
  });
});

describe("a skill that is not resolved", () => {
  test("a skill with no echo fails resolved alone", async () => {
    const judged = await judge({ S6: { events: (events) => void events.splice(events.indexOf(replayOf(events, "tdd")), 1) } });
    expect(judged.failed).toEqual(["S6.resolved"]);
    expect(said(judged, "resolved")).toStartWith("saw skills echoed as a command: 1 lacking (tdd);");
  });

  test("a skill passed on as typed fails resolved and none-unresolved", async () => {
    const judged = await judge({ S6: { events: (events) => void (replayOf(events, "tdd").message.content = "/pstack:tdd") } });
    expect(judged.failed).toEqual(["S6.resolved", "S6.none-unresolved"]);
    expect(said(judged, "none-unresolved")).toBe("saw passed on as typed: /pstack:tdd, want no skill of the tree passed on as typed");
  });

  test("a skill echoed and never expanded fails expanded alone", async () => {
    const judged = await judge({ S6: { transcriptEdit: transcript((records) => records.filter((record) => !expandedBy("how")(record))) } });
    expect(judged.failed).toEqual(["S6.expanded"]);
    expect(said(judged, "expanded")).toStartWith("saw skills expanded from the stage: 1 lacking (how);");
  });

  test("a skill expanded twice fails expanded alone", async () => {
    const twice = transcript((records) => records.flatMap((record) => (expandedBy("how")(record) ? [record, record] : [record])));
    const judged = await judge({ S6: { transcriptEdit: twice } });
    expect(judged.failed).toEqual(["S6.expanded"]);
    expect(said(judged, "expanded")).toContain("1 twice (how)");
  });

  test("a skill expanded from a directory that is not the stage's fails expanded alone", async () => {
    const elsewhere = transcript((records) =>
      records.map((record) => (expandedBy("how")(record) ? { ...record, message: { ...record.message, content: [{ type: "text", text: "Base directory for this skill: /elsewhere/plugins/pstack/skills/how" }] } } : record)),
    );
    const judged = await judge({ S6: { transcriptEdit: elsewhere } });
    expect(judged.failed).toEqual(["S6.expanded"]);
  });

  test("a trace with no transcript is unobservable", async () => {
    const judged = await judge({ S6: { transcript: "" } });
    expect(judged).toMatchObject({ verdict: "unobservable", reason: "the session transcript is missing" });
  });
});

describe("a skill hidden from users", () => {
  test("a refusal that cost a turn fails refused alone", async () => {
    const judged = await judge({ S6: { events: (events) => void (refusals(events)[0].num_turns = 1) } });
    expect(judged.failed).toEqual(["S6.refused"]);
  });

  test("a hidden skill that was answered some other way fails refused alone", async () => {
    const judged = await judge({ S6: { events: (events) => void (refusals(events)[0].result = "Not logged in") } });
    expect(judged.failed).toEqual(["S6.refused"]);
    expect(said(judged, "refused")).toStartWith("saw 23 refusals (turns 0); 24 of 24 hidden skills typed");
  });

  test("a hidden skill that was never typed fails refused alone", async () => {
    const untyped = transcript((records) => records.filter((record) => record.message?.content !== "/pstack:principle-fix-root-causes"));
    const judged = await judge({ S6: { transcriptEdit: untyped } });
    expect(judged.failed).toEqual(["S6.refused"]);
    expect(said(judged, "refused")).toContain("23 of 24 hidden skills typed");
  });

  test("a hidden skill that was expanded fails expanded and leaves-refused", async () => {
    const stray = { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: <STAGE>/plugins/pstack/skills/principle-fix-root-causes" }] } };
    const judged = await judge({ S6: { transcriptEdit: transcript((records) => [...records, stray]) } });
    expect(judged.failed).toEqual(["S6.expanded", "S6.leaves-refused"]);
    expect(said(judged, "expanded")).toContain("1 not the tree's (principle-fix-root-causes)");
  });
});

describe("a name that no skill has", () => {
  test("an unknown name that the CLI wrapped as a command fails passed-through, and resolved lists it", async () => {
    const wrap = (events) => void (replayOf(events, "does-not-exist").message.content = "<command-message>pstack:does-not-exist</command-message>\n<command-name>/pstack:does-not-exist</command-name>");
    const judged = await judge({ S6: { events: wrap } });
    expect(judged.failed).toEqual(["S6.resolved", "S6.passed-through"]);
    expect(said(judged, "resolved")).toContain("1 not the tree's (does-not-exist)");
  });

  test("an unknown name with no unknown_command_fallback in the transcript fails passed-through alone", async () => {
    const judged = await judge({ S6: { transcriptEdit: transcript((records) => records.filter((record) => record.attachment?.type !== "unknown_command_fallback")) } });
    expect(judged.failed).toEqual(["S6.passed-through"]);
    expect(said(judged, "passed-through")).toStartWith("saw 1 replays of /pstack:does-not-exist as typed; 0 unknown_command_fallback in the transcript");
  });

  test("an unknown name that was never typed fails answered and passed-through", async () => {
    const judged = await judge({
      S6: {
        events: (events) => {
          events.splice(events.indexOf(replayOf(events, "does-not-exist")), 1);
          events.splice(events.findLastIndex((event) => event.type === "result"), 1);
        },
      },
    });
    expect(judged.failed).toEqual(["S6.answered", "S6.passed-through"]);
  });
});

describe("what a run must have cost", () => {
  test("a result that cost something is a model call: the integrity rule fails, and the check cannot be judged", async () => {
    const judged = await judge({ S6: { events: (events) => void (events.findLast((event) => event.type === "result").total_cost_usd = 0.003) } });
    expect(judged.verdict).toBe("error");
    expect(judged.reason).toContain("the exchanges are offered only for a trace that cost nothing and called no model");
  });

  test("fewer results than messages typed fails answered", async () => {
    const judged = await judge({ S6: { events: (events) => void events.splice(events.findLastIndex((event) => event.type === "result"), 1) } });
    expect(judged.failed).toContain("S6.answered");
    expect(said(judged, "answered")).toBe("saw 68 results for the messages typed, want 69 results, one for each of the 44 skills a user can invoke, the 24 it cannot and 1 unknown name");
  });
});

// What is typed is made of the stage's own skill directories, so the flow and
// the check agree on every tree: 68 skills and a name no skill has.
test("the flow types one message for each skill directory of the stage, and one for a name it has none of", async () => {
  const flow = (await loadDir(FLOWS_DIR)).find((each) => each.id === "S6");
  const stage = fixtureStage(join(tempDir(), "stage"), S6.tree);
  const [run] = plan([flow], tempDir(), { PATH: "/usr/bin" }, { stage });
  const typed = run.stdin.trimEnd().split("\n").map((line) => JSON.parse(line).message.content);
  const dirs = readdirSync(join(stage, "plugins/pstack/skills")).sort();
  expect(typed).toEqual([...dirs.map((name) => `/pstack:${name}`), "/pstack:does-not-exist"]);
  expect(typed.length).toBe(69);
});
