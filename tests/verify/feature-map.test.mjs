// The feature map says which checks cover which paths of the Claude Code
// build. It is only worth reading while it is complete and true: a path the
// verifier stages with no entry, an entry naming a check that is gone, or a
// glob that matches nothing each leave the map saying something false.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CHECKS_DIR, listDir, PRODUCT } from "../../tools/verify/paths.mjs";

const repo = join(import.meta.dir, "../..");
const MAP = join(repo, "tools/verify/feature-map.json");

const matches = (glob, file) => new Bun.Glob(glob).match(file);

// Every problem with `map`, given the paths the verifier stages and the ids
// of the checks that exist. Covered entries win over uncovered ones, so an
// uncovered glob may be as broad as a folder.
export function mapProblems(map, files, ids) {
  const problems = [];
  const lists = { covered: map?.covered, uncovered: map?.uncovered };
  for (const [name, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) problems.push(`"${name}" must be a list`);
  }
  if (problems.length) return problems;
  const entries = [...map.covered.map((entry) => ({ ...entry, kind: "covered" })), ...map.uncovered.map((entry) => ({ ...entry, kind: "uncovered" }))];

  for (const entry of entries) {
    const label = `${entry.kind} entry ${JSON.stringify(entry.globs)}`;
    if (!Array.isArray(entry.globs) || !entry.globs.length || entry.globs.some((glob) => typeof glob !== "string" || !glob)) {
      problems.push(`${label} needs a list of globs`);
      continue;
    }
    if (entry.kind === "covered") {
      if (typeof entry.feature !== "string" || !entry.feature) problems.push(`${label} needs a feature sentence`);
      if (!Array.isArray(entry.checks) || !entry.checks.length) problems.push(`${label} names no check; a path no check covers belongs under "uncovered"`);
      for (const id of entry.checks ?? []) {
        if (!ids.includes(id)) problems.push(`${label} names check ${id}, which does not exist; checks: ${ids.join(", ")}`);
      }
    } else if (typeof entry.reason !== "string" || !entry.reason) {
      problems.push(`${label} needs a reason`);
    }
    for (const glob of entry.globs) {
      if (!files.some((file) => matches(glob, file))) problems.push(`${label}: glob ${glob} matches no path the verifier stages`);
    }
  }

  for (const file of files) {
    if (!entries.some((entry) => Array.isArray(entry.globs) && entry.globs.some((glob) => matches(glob, file)))) {
      problems.push(`${file} matches no entry; add it to "covered" with the checks that judge it, or to "uncovered" with a reason`);
    }
  }
  return problems;
}

// What the stage would take from the tree: tracked and untracked files that
// are not ignored, as the snapshot sees them.
function productFiles() {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...PRODUCT], { cwd: repo, encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split("\0").filter((file) => file && existsSync(join(repo, file))).sort();
}

describe("the scan", () => {
  const map = {
    covered: [{ feature: "loads", globs: ["plugins/pstack/skills/*/SKILL.md"], checks: ["S2"] }],
    uncovered: [{ globs: ["plugins/pstack/hooks/**", "plugins/pstack/.codex-plugin/**"], reason: "other runtimes" }],
  };
  const files = ["plugins/pstack/skills/a/SKILL.md", "plugins/pstack/hooks/x.sh", "plugins/pstack/.codex-plugin/plugin.json"];

  test("accepts a complete map", () => {
    expect(mapProblems(map, files, ["S2", "S3"])).toEqual([]);
  });

  test("names a path no entry matches", () => {
    expect(mapProblems(map, [...files, "plugins/pstack/newdir/file.md"], ["S2"])).toEqual([expect.stringContaining("plugins/pstack/newdir/file.md matches no entry")]);
  });

  test("names a check that does not exist", () => {
    expect(mapProblems(map, files, ["S3"])).toEqual([expect.stringContaining("names check S2, which does not exist")]);
  });

  test("names a glob that matches nothing", () => {
    expect(mapProblems(map, files.slice(0, 2), ["S2"])).toEqual([expect.stringContaining("glob plugins/pstack/.codex-plugin/** matches no path")]);
  });

  test("refuses a covered entry with no check and an uncovered one with no reason", () => {
    const bare = { covered: [{ feature: "x", globs: ["plugins/pstack/skills/*/SKILL.md"], checks: [] }], uncovered: [{ globs: ["plugins/pstack/hooks/**"] }] };
    expect(mapProblems(bare, files.slice(0, 2), ["S2"]).join("\n")).toMatch(/names no check[\s\S]*needs a reason/);
  });
});

describe("the repository's map", () => {
  test("covers every path the verifier stages, and names only checks that exist", () => {
    const map = JSON.parse(readFileSync(MAP, "utf8"));
    const ids = listDir(CHECKS_DIR).map((check) => check.id);
    expect(mapProblems(map, productFiles(), ids)).toEqual([]);
  });

  test("names every check the verifier has, so a check cannot run without saying what it covers", () => {
    const map = JSON.parse(readFileSync(MAP, "utf8"));
    const ids = listDir(CHECKS_DIR).map((check) => check.id);
    expect(ids.filter((id) => !map.covered.some((entry) => entry.checks.includes(id)))).toEqual([]);
  });

  test("a new file in a folder the map lists by name is unmapped", () => {
    const map = JSON.parse(readFileSync(MAP, "utf8"));
    const ids = listDir(CHECKS_DIR).map((check) => check.id);
    for (const file of ["plugins/pstack/hooks/pre-commit-claude.sh", "plugins/pstack/.claude-plugin/extra.json"]) {
      expect(mapProblems(map, [...productFiles(), file], ids)).toEqual([expect.stringContaining(`${file} matches no entry`)]);
    }
  });

  test("hooks.json is judged for its SessionStart registration only, and says so", () => {
    const map = JSON.parse(readFileSync(MAP, "utf8"));
    const note = map.uncovered.find((entry) => entry.globs.includes("plugins/pstack/hooks/hooks.json"));
    expect(note?.reason).toMatch(/other than SessionStart/);
  });
});
