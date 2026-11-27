// A bug that reached a release is only closed when something now fails on
// it. Each entry in tools/verify/escapes.json names the release it escaped
// in, says what went wrong, and points at a check or a test that fails on a
// repeat. The file may be empty; a vague or dangling entry is what fails.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CHECKS_DIR, listDir } from "../../tools/verify/paths.mjs";

const repo = join(import.meta.dir, "../..");
const KEYS = ["caught_by", "description", "version"];

// `versions` are the `## <version>` headings of CHANGES.md, `ids` the check
// ids, and `isTest` says whether a repository path is a test file.
export function escapeProblems(ledger, versions, ids, isTest) {
  if (!ledger || !Array.isArray(ledger.escapes) || Object.keys(ledger).length !== 1) return ['the file must be {"escapes": [...]}'];
  return ledger.escapes.flatMap((entry, at) => {
    const label = `escapes[${at}]${entry?.version ? ` (${entry.version})` : ""}`;
    if (!entry || typeof entry !== "object") return [`${label} must be an object`];
    const problems = [];
    const keys = Object.keys(entry).sort();
    if (keys.join() !== KEYS.join()) problems.push(`${label} must have exactly ${KEYS.join(", ")}; has ${keys.join(", ")}`);
    if (!versions.includes(entry.version)) problems.push(`${label} names version ${entry.version}, which has no "## ${entry.version}" heading in CHANGES.md`);
    if (typeof entry.description !== "string" || !entry.description.trim() || /[\r\n]/.test(entry.description)) problems.push(`${label} needs a one-line description`);
    const by = entry.caught_by;
    if (typeof by !== "string" || !(ids.includes(by) || (/^tests\/[^\s]+\.test\.mjs$/.test(by) && isTest(by)))) {
      problems.push(`${label} is caught by ${JSON.stringify(by)}, which is neither a check id (${ids.join(", ")}) nor an existing tests/**/*.test.mjs file`);
    }
    return problems;
  });
}

describe("the scan", () => {
  const good = { version: "0.9.1", description: "The hook printed to stdout.", caught_by: "S3" };
  const check = (entry, tests = []) => escapeProblems({ escapes: [entry] }, ["0.9.1"], ["S2", "S3"], (path) => tests.includes(path));

  test("accepts an empty ledger, a check id and a test file", () => {
    expect(escapeProblems({ escapes: [] }, [], [], () => false)).toEqual([]);
    expect(check(good)).toEqual([]);
    expect(check({ ...good, caught_by: "tests/a.test.mjs" }, ["tests/a.test.mjs"])).toEqual([]);
  });

  test("names a version CHANGES.md lacks", () => {
    expect(check({ ...good, version: "9.9.9" })).toEqual([expect.stringContaining("no \"## 9.9.9\" heading")]);
  });

  test("names a check or test that does not exist", () => {
    expect(check({ ...good, caught_by: "S9" })).toEqual([expect.stringContaining('caught by "S9"')]);
    expect(check({ ...good, caught_by: "tests/gone.test.mjs" })).toEqual([expect.stringContaining("tests/gone.test.mjs")]);
  });

  test("refuses a missing, empty or multi-line description and a stray key", () => {
    expect(check({ version: "0.9.1", caught_by: "S3" })).not.toEqual([]);
    expect(check({ ...good, description: "  " })).toEqual([expect.stringContaining("one-line description")]);
    expect(check({ ...good, description: "a\nb" })).toEqual([expect.stringContaining("one-line description")]);
    expect(check({ ...good, note: "x" })).toEqual([expect.stringContaining("must have exactly")]);
  });
});

describe("the repository's ledger", () => {
  test("every escape names a release, a description and something that now fails on it", () => {
    const ledger = JSON.parse(readFileSync(join(repo, "tools/verify/escapes.json"), "utf8"));
    const versions = [...readFileSync(join(repo, "CHANGES.md"), "utf8").matchAll(/^## (\S+)/gm)].map((match) => match[1]);
    const ids = listDir(CHECKS_DIR).map((check) => check.id);
    expect(escapeProblems(ledger, versions, ids, (path) => existsSync(join(repo, path)))).toEqual([]);
  });
});
