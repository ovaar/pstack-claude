// Check S2 over its recordings. Each doctored trace copies what the CLI was
// seen to do with a planted defect (2.1.332, logged out) and must turn the
// one assertion that guards against it.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";

const S2 = await shipped("S2");
const SKILLS = "plugins/pstack/skills";

afterEach(cleanup);

const judge = async (edits) => (await check(evidence(S2, edits))).checks.find((each) => each.id === "S2");
const init = (events) => events.find((event) => event.subtype === "init");
const saw = (judged, id) => judged.assertions.find((item) => item.id === id).saw;
const without = (list, name) => list.filter((each) => each !== name);

test("the untouched tree passes", async () => {
  const judged = await judge();
  expect(judged.verdict).toBe("pass");
  expect(judged.assertions.map((item) => item.saw)).toEqual(["no plugin_errors", "44 skills in the tree, each in init.skills", "no pstack: slash command beside the tree's skills"]);
  expect(judged.observations).toEqual([]);
});

test("a dependency the loader cannot satisfy fails on plugin_errors, and nothing of the plugin loaded", async () => {
  const judged = await judge({ S2: { fixture: "dependency-unsatisfied.S2.context" } });
  expect(judged.failed).toEqual(["S2.context.plugin-once", "S2.plugin-errors", "S2.skills"]);
  expect(saw(judged, "plugin-errors")).toBe("plugin_errors dependency-unsatisfied (pstack@inline)");
  expect(judged.integrity.find((rule) => rule.id === "context.plugin-once").saw).toBe("0 plugins named pstack in init.plugins");
});

test("a loader error fails plugin-errors alone", async () => {
  const judged = await judge({ S2: { events: (events) => void (init(events).plugin_errors = [{ plugin: "inline[0]", type: "path-not-found", message: "gone" }]) } });
  expect(judged.failed).toEqual(["S2.plugin-errors"]);
});

// A SKILL.md with no frontmatter, an empty one, one with broken YAML and one
// without a description each left init.skills and stayed in
// init.slash_commands, with plugin_errors still absent.
test("a skill in the tree that the loader left out without an error fails skills alone", async () => {
  const judged = await judge({ S2: { events: (events) => void (init(events).skills = without(init(events).skills, "pstack:bro")) } });
  expect(judged.failed).toEqual(["S2.skills"]);
  expect(saw(judged, "skills")).toBe("skills in the tree and not in init.skills: bro");
});

test("a skill a user cannot invoke, and a directory with no SKILL.md, are not expected in init.skills", async () => {
  const judged = await judge({
    stage: (stage) => {
      mkdirSync(join(stage, SKILLS, "principle-hidden"));
      writeFileSync(join(stage, SKILLS, "principle-hidden/SKILL.md"), "---\nname: principle-hidden\nuser-invocable: false\n---\n");
      mkdirSync(join(stage, SKILLS, "principle-shouted"));
      writeFileSync(join(stage, SKILLS, "principle-shouted/SKILL.md"), "---\nname: principle-shouted\nuser-invocable: False\n---\n");
      mkdirSync(join(stage, SKILLS, "shared-assets"));
    },
  });
  expect(judged.verdict).toBe("pass");
  expect(saw(judged, "skills")).toBe("44 skills in the tree, each in init.skills");
});

test("a skill whose frontmatter cannot be read is expected in init.skills", async () => {
  const judged = await judge({
    stage: (stage) => {
      mkdirSync(join(stage, SKILLS, "unreadable"));
      writeFileSync(join(stage, SKILLS, "unreadable/SKILL.md"), "user-invocable: false\nno frontmatter fence\n");
    },
  });
  expect(judged.failed).toEqual(["S2.skills"]);
});

// A file under commands/ shows in init.slash_commands and not in init.skills.
test("a slash command with no skill in the tree fails commands alone", async () => {
  const judged = await judge({ S2: { events: (events) => void init(events).slash_commands.push("pstack:stray") } });
  expect(judged.failed).toEqual(["S2.commands"]);
  expect(saw(judged, "commands")).toBe("slash commands with no skill in the tree: pstack:stray");
});

test("without an init event the check is unobservable, and the missing event fails integrity", async () => {
  const judged = await judge({ S2: { events: (events) => events.filter((event) => event.subtype !== "init") } });
  expect(judged).toMatchObject({ verdict: "fail", reason: "the init event is missing", failed: ["S2.context.init-present"] });
});
