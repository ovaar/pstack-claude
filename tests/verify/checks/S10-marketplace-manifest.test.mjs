// Check S10 over its recordings. A doctored trace or tree starts from the
// untouched one, changes one fact, and must turn the assertion that guards it.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../../tools/verify/check.mjs";
import { markdown } from "../../../tools/verify/evidence.mjs";
import { cleanup, evidence, shipped } from "../harness.mjs";

const S10 = await shipped("S10");
const MANIFEST = ".claude-plugin/marketplace.json";
const PLUGIN_MANIFEST = "plugins/pstack/.claude-plugin/plugin.json";

afterEach(cleanup);

const judge = async (edits) => (await check(evidence(S10, edits), S10.checks)).checks.find((each) => each.id === "S10");
const said = (judged, id) => {
  const item = judged.assertions.find((each) => each.id === id);
  return `saw ${item.saw}, want ${item.want}`;
};
// A change to a JSON file of the stage.
const edit = (path, change) => (stage) => {
  const file = join(stage, path);
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, JSON.stringify(json));
};

test("the untouched tree passes, and its row quotes the source and the three versions", async () => {
  const result = await check(evidence(S10), S10.checks);
  expect(result.checks.find((each) => each.id === "S10")).toMatchObject({ verdict: "pass", failed: [], observations: [] });
  expect(markdown(result).split("\n").find((line) => line.startsWith("| S10 "))).toBe(
    '| S10 the marketplace manifest names the plugin the tree holds | pass | success true, manifest marketplace, no errors and no warnings; 1 plugins listed in .claude-plugin/marketplace.json; source ./plugins/pstack, plugins/pstack/.claude-plugin/plugin.json there; entry name "pstack", plugin manifest name "pstack"; entry version "0.9.158", plugin manifest version "0.9.158", VERSION "0.9.158"; 7 of 7 integrity rules hold |',
  );
});

// Recordings of the real validator over trees with one mistake.
describe("recorded failures", () => {
  test("an entry whose version is not the plugin's is a warning of the validator, and fails valid and version", async () => {
    const judged = await judge({ stage: edit(MANIFEST, (json) => void (json.plugins[0].version = "9.9.9")), S10: { fixture: "version-mismatch.S10.validate" } });
    expect(judged.failed).toEqual(["S10.valid", "S10.version"]);
    expect(said(judged, "valid")).toContain('plugins[0].version: Entry declares version "9.9.9"');
    expect(said(judged, "version")).toBe('saw entry version "9.9.9", plugin manifest version "0.9.158", VERSION "0.9.158", want the entry\'s version, the plugin manifest\'s and VERSION are one');
  });

  test("a manifest that is not JSON fails valid, parses and everything read from it", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, MANIFEST), "{ nope"), S10: { fixture: "manifest-not-json.S10.validate" } });
    expect(judged.failed).toEqual(["S10.valid", "S10.parses", "S10.source", "S10.name", "S10.version"]);
    expect(said(judged, "valid")).toContain("Invalid JSON syntax");
  });

  test("a tree with no marketplace manifest fails target, because the validator looked at the directory", async () => {
    const judged = await check(evidence(S10, { stage: (stage) => rmSync(join(stage, MANIFEST)), S10: { fixture: "manifest-missing.S10.validate" } }), S10.checks);
    expect(judged.checks.find((each) => each.id === "S10")).toMatchObject({ verdict: "fail", failed: ["S10.validate.target"], reason: "the stage's marketplace manifest is missing" });
  });
});

// The validator accepts all of these. The tree is what shows them.
describe("what the validator does not look at", () => {
  test("a source that names a directory the tree does not hold fails source, and what is read through it", async () => {
    const judged = await judge({ stage: edit(MANIFEST, (json) => void (json.plugins[0].source = "./plugins/nope")) });
    expect(judged.failed).toEqual(["S10.source", "S10.name", "S10.version"]);
    expect(said(judged, "source")).toStartWith('saw sources "./plugins/nope", want an entry whose source is the plugin directory plugins/pstack');
  });

  test("a source with a trailing slash or no ./ names the same directory", async () => {
    for (const source of ["plugins/pstack", "./plugins/pstack/", "././plugins/pstack"]) {
      expect((await judge({ stage: edit(MANIFEST, (json) => void (json.plugins[0].source = source)) })).verdict).toBe("pass");
    }
  });

  test("a source that is not a string fails source", async () => {
    expect((await judge({ stage: edit(MANIFEST, (json) => void (json.plugins[0].source = { source: "github" })) })).failed).toContain("S10.source");
  });

  test("a plugin directory with no plugin manifest fails source", async () => {
    const judged = await judge({ stage: (stage) => rmSync(join(stage, PLUGIN_MANIFEST)) });
    expect(judged.failed).toEqual(["S10.source", "S10.name", "S10.version"]);
    expect(said(judged, "source")).toStartWith("saw source ./plugins/pstack, no .claude-plugin/plugin.json there");
  });

  test("an entry under another name than the plugin's fails name alone", async () => {
    const judged = await judge({ stage: edit(MANIFEST, (json) => void (json.plugins[0].name = "pstackx")) });
    expect(judged.failed).toEqual(["S10.name"]);
  });

  test("a version bump of VERSION that the manifests did not follow fails version alone", async () => {
    const judged = await judge({ stage: (stage) => writeFileSync(join(stage, "VERSION"), "0.9.159\n") });
    expect(judged.failed).toEqual(["S10.version"]);
  });

  test("an entry with no version fails version alone", async () => {
    const judged = await judge({ stage: edit(MANIFEST, (json) => void delete json.plugins[0].version) });
    expect(judged.failed).toEqual(["S10.version"]);
  });

  test("a plugin manifest whose version is not the tree's fails version alone", async () => {
    const judged = await judge({ stage: edit(PLUGIN_MANIFEST, (json) => void (json.version = "0.9.159")) });
    expect(judged.failed).toEqual(["S10.version"]);
  });

  test("a manifest that lists no plugin fails parses, source, name and version", async () => {
    const judged = await judge({ stage: edit(MANIFEST, (json) => void (json.plugins = [])) });
    expect(judged.failed).toEqual(["S10.parses", "S10.source", "S10.name", "S10.version"]);
  });

  test("a manifest with another entry beside the plugin's still passes", async () => {
    const judged = await judge({ stage: edit(MANIFEST, (json) => void json.plugins.unshift({ name: "other", source: "./plugins/other" })) });
    expect(judged.verdict).toBe("pass");
  });
});

test("a trace that is not the validator's document fails document and cannot be judged", async () => {
  const judged = await judge({ S10: { raw: () => "Error: no\n" } });
  expect(judged.failed).toEqual(["S10.validate.document"]);
  expect(judged.reason).toBe("the validator's document is missing");
});
