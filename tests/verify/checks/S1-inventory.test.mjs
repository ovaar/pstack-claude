// Check S1 over its recordings. A doctored trace starts from the untouched
// recording and changes one fact, and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";

const S1 = await shipped("S1");
const PLUGIN = "plugins/pstack";

afterEach(cleanup);

const judge = async (edits) => (await check(evidence(S1, edits), S1.checks)).checks.find((each) => each.id === "S1");
const provides = (events) => events[0].provides;
const said = (judged, id) => {
  const item = judged.assertions.find((each) => each.id === id);
  return `saw ${item.saw}, want ${item.want}`;
};
const dispatching = (agent) => (stage) => writeFileSync(join(stage, PLUGIN, "skills/bro/SKILL.md"), `---\nname: bro\n---\nSpawn subagent_type: "pstack:${agent}".\n`);

test("the untouched tree passes, and its row counts what it provides", async () => {
  const result = await check(evidence(S1), S1.checks);
  expect(result.checks.find((each) => each.id === "S1")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  expect(markdown(result).split("\n").find((line) => line.startsWith("| S1 "))).toBe(
    "| S1 the plugin provides what the tree holds | pass | success true, manifest plugin, no errors; 68 skills, each the tree's; 4 agents, each the tree's; 1 hooks, each the tree's; 68 skills and 4 agents, each in the inventory; no command provided; 7 pstack: names in the skills, agents and mandate, each provided; 7 of 7 integrity rules hold |",
  );
});

// Each of these is a recording of the real CLI over a tree with one mistake,
// checked against the untouched tree's files, as a loader that dropped what
// the tree holds would be.
describe("recorded failures", () => {
  test("an agents key in plugin.json that restricts the plugin to one agent fails agents alone", async () => {
    const judged = await judge({ S1: { fixture: "agents-key.S1.validate" } });
    expect(judged.failed).toEqual(["S1.agents"]);
    expect(said(judged, "agents")).toStartWith("saw agents: 1 provided, 4 in the tree; provided by no file: none; in the tree and not provided: pstack:comment-sicko, ");
  });

  test("a command file beside the skills fails no-commands alone", async () => {
    const judged = await judge({ S1: { fixture: "command-trampoline.S1.validate" } });
    expect(judged.failed).toEqual(["S1.no-commands"]);
    expect(said(judged, "no-commands")).toBe("saw commands provided: pstack:bro, want no command: a skill is its own slash command");
  });

  test("a hook registered under an event that does not exist fails hooks alone", async () => {
    const judged = await judge({ S1: { fixture: "hook-event-misspelled.S1.validate" } });
    expect(judged.failed).toEqual(["S1.hooks"]);
    expect(said(judged, "hooks")).toStartWith("saw hooks: 0 provided, 1 in the tree; provided by no file: none; in the tree and not provided: SessionStart | startup|resume|clear|compact | command | ");
  });
});

describe("what the loader provides against what the tree holds", () => {
  test("a skill the loader dropped fails skills alone", async () => {
    const judged = await judge({ S1: { events: (events) => void (provides(events).skills = provides(events).skills.filter((name) => name !== "pstack:bro")) } });
    expect(judged.failed).toEqual(["S1.skills"]);
    expect(said(judged, "skills")).toStartWith("saw skills: 67 provided, 68 in the tree; provided by no file: none; in the tree and not provided: pstack:bro; listed twice: none");
  });

  test("a skill provided that no directory holds fails skills alone", async () => {
    const judged = await judge({ S1: { events: (events) => void provides(events).skills.push("pstack:ghost") } });
    expect(judged.failed).toEqual(["S1.skills"]);
    expect(said(judged, "skills")).toContain("provided by no file: pstack:ghost");
  });

  test("a skill listed twice fails skills alone", async () => {
    const judged = await judge({ S1: { events: (events) => void provides(events).skills.push("pstack:bro") } });
    expect(judged.failed).toEqual(["S1.skills"]);
    expect(said(judged, "skills")).toContain("listed twice: pstack:bro");
  });

  test("an agent under its file name instead of its frontmatter name fails agents alone", async () => {
    const judged = await judge({ S1: { events: (events) => void (provides(events).agents[0] = "pstack:comment-sicko-file") } });
    expect(judged.failed).toEqual(["S1.agents"]);
  });

  test("a loaded matcher narrower than the one the tree registers fails hooks alone", async () => {
    const judged = await judge({ S1: { events: (events) => void (provides(events).hooks[0].matcher = "startup|clear|compact") } });
    expect(judged.failed).toEqual(["S1.hooks"]);
  });

  test("a matcher the tree narrowed and the loader followed passes hooks, which S4 holds to the four sources", async () => {
    const hooks = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "x" }] }] } });
    const judged = await judge({
      stage: (stage) => writeFileSync(join(stage, PLUGIN, "hooks/hooks.json"), hooks),
      S1: { events: (events) => void Object.assign(provides(events).hooks, [{ event: "SessionStart", matcher: "startup", type: "command", command: "x" }]) },
    });
    expect(judged.failed).toEqual([]);
  });

  test("a loader error fails valid alone", async () => {
    const judged = await judge({ S1: { events: ([report]) => void Object.assign(report, { success: false, manifest: { ...report.manifest, errors: [{ path: "hooks", message: "bad hook" }] } }) } });
    expect(judged.failed).toEqual(["S1.valid"]);
    expect(said(judged, "valid")).toStartWith("saw success false, manifest plugin, errors bad hook");
  });
});

// Deleting a file from the tree leaves the loader's list and the tree equal.
// What the rest of the tree still says is what shows it.
describe("a file deleted from the tree that the tree still names", () => {
  test("an agent a skill dispatches to fails references alone", async () => {
    const judged = await judge({
      stage: (stage) => {
        rmSync(join(stage, PLUGIN, "agents/comment-sicko.md"));
        dispatching("comment-sicko")(stage);
      },
      S1: { events: (events) => void (provides(events).agents = provides(events).agents.filter((name) => name !== "pstack:comment-sicko")) },
    });
    expect(judged.failed).toEqual(["S1.inventory", "S1.references"]);
    expect(said(judged, "references")).toStartWith("saw named in the tree and not provided: pstack:comment-sicko, want ");
  });

  test("a skill the mandate names fails references alone", async () => {
    const judged = await judge({
      stage: (stage) => rmSync(join(stage, PLUGIN, "skills/poteto-mode"), { recursive: true }),
      S1: { events: (events) => void (provides(events).skills = provides(events).skills.filter((name) => name !== "pstack:poteto-mode")) },
    });
    expect(judged.failed).toEqual(["S1.inventory", "S1.references"]);
    expect(said(judged, "references")).toStartWith("saw named in the tree and not provided: pstack:poteto-mode, want ");
  });

  test("a tree that names no skill at all cannot pass references", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, PLUGIN, "hooks/session-start-context.md"), "no names\n") });
    expect(judged.failed).toEqual(["S1.references"]);
    expect(said(judged, "references")).toStartWith("saw no pstack: name in the skills, agents or mandate");
  });
});

// The loader and the stage read the same tree, so a skill that no file names
// leaves them equal and the references quiet: the inventory is what fails.
describe("a file deleted from the tree that nothing names", () => {
  test.each(["bro", "principle-make-operations-idempotent"])("the skill %s fails inventory alone", async (skill) => {
    const judged = await judge({
      stage: (stage) => rmSync(join(stage, PLUGIN, "skills", skill), { recursive: true }),
      S1: { events: (events) => void (provides(events).skills = provides(events).skills.filter((name) => name !== `pstack:${skill}`)) },
    });
    expect(judged.failed).toEqual(["S1.inventory"]);
    expect(said(judged, "inventory")).toStartWith(`saw skills: in the inventory and not the tree: pstack:${skill}; in the tree and not the inventory: none; agents: `);
  });

  test("an agent nothing dispatches to fails inventory alone", async () => {
    const judged = await judge({
      stage: (stage) => rmSync(join(stage, PLUGIN, "agents/thermo-nuclear-review-subagent.md")),
      S1: { events: (events) => void (provides(events).agents = provides(events).agents.filter((name) => name !== "pstack:thermo-nuclear-review-subagent")) },
    });
    expect(judged.failed).toEqual(["S1.inventory"]);
  });

  test("a skill added without a line in the inventory fails inventory alone", async () => {
    const judged = await judge({
      stage: (stage) => {
        mkdirSync(join(stage, PLUGIN, "skills/new-skill"));
        writeFileSync(join(stage, PLUGIN, "skills/new-skill/SKILL.md"), "---\nname: new-skill\n---\n");
      },
      S1: { events: (events) => void provides(events).skills.push("pstack:new-skill") },
    });
    expect(judged.failed).toEqual(["S1.inventory"]);
    expect(said(judged, "inventory")).toContain("in the tree and not the inventory: pstack:new-skill");
  });
});

// The inventory is hand-written, so the real tree is held to it here, where
// a change to either side gets a plain failure.
test("the inventory in the check file is the plugin directory this checkout holds", async () => {
  const names = (dir, keep) => readdirSync(join(import.meta.dir, "../../..", PLUGIN, dir)).filter(keep).map((file) => file.replace(/\.md$/, "")).sort();
  const checkFile = readFileSync(join(import.meta.dir, "../../../tools/verify/checks/S1-inventory.mjs"), "utf8");
  const listed = (name) => [...checkFile.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/"([^"]+)"/g)].map((each) => each[1]);
  expect(listed("SKILLS")).toEqual(names("skills", (dir) => existsSync(join(import.meta.dir, "../../..", PLUGIN, "skills", dir, "SKILL.md"))));
  expect(listed("AGENTS")).toEqual(names("agents", (file) => file.endsWith(".md")));
});

test("a trace without the validator's document fails document", async () => {
  const judged = await judge({ S1: { raw: () => "" } });
  expect(judged.verdict).toBe("fail");
  expect(judged.failed).toContain("S1.validate.document");
  expect(judged.reason).toBe("the validator's document is missing");
});
