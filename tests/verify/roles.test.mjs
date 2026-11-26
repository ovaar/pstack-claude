// The three roles stay apart only while their modules do. A checker that
// could start a process could rerun what it judges, and a driver that read
// the checks could shape its runs to pass them.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { CHECKS_DIR, FLOWS_DIR, loadDir } from "../../tools/verify/paths.mjs";

const VERIFY = dirname(CHECKS_DIR);
const read = (file) => readFileSync(join(VERIFY, file), "utf8");
const modules = readdirSync(VERIFY, { recursive: true })
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => file.split("\\").join("/"))
  .sort();
const checkFiles = modules.filter((file) => file.startsWith("checks/"));

const startsProcesses = (source) => /child_process|\bBun\s*\.\s*(?:spawn|\$)/.test(source);
const imports = (source) => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);

// Every module a file reaches through relative imports, itself included.
function reach(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const specifier of imports(read(file)).filter((each) => each.startsWith("."))) {
    reach(relative(VERIFY, join(VERIFY, dirname(file), specifier)).split("\\").join("/"), seen);
  }
  return seen;
}

test("the scan sees an import of child_process and a call to Bun.spawn", () => {
  expect(startsProcesses('import "node:child_process";')).toBe(true);
  expect(startsProcesses('const { spawnSync } = await import("child_process");')).toBe(true);
  expect(startsProcesses("Bun.spawn(['claude']);")).toBe(true);
  expect(imports('import "node:child_process";\nimport { a } from "./a.mjs";\nawait import("./b.mjs");')).toEqual(["node:child_process", "./a.mjs", "./b.mjs"]);
});

test("only setup and the driver can start a process", () => {
  expect(modules.filter((file) => startsProcesses(read(file)))).toEqual(["drive.mjs", "setup.mjs"]);
});

test("the checker reaches neither of them through its imports", () => {
  expect([...reach("check.mjs")].sort()).toEqual(["../plugin.mjs", "check.mjs", "paths.mjs", "stage.mjs", "trace.mjs"]);
  expect(startsProcesses(read("../plugin.mjs"))).toBe(false);
});

test("the driver imports no check, no checker and no trace reader", () => {
  expect(imports(read("drive.mjs")).filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
});

// A check gets its traces and the stage handed in. One that imported a
// module, or read the process, could look past them at the working tree.
test.each(checkFiles.map((file) => [file]))("%s imports nothing and reads no global state", (file) => {
  const source = read(file);
  expect(imports(source)).toEqual([]);
  expect(source).not.toMatch(/\brequire\s*\(|\bprocess\s*\.|\bBun\s*\.|\bglobalThis\b|\bfetch\s*\(/);
});

test("flows/ and checks/ hold the same checks in the same tiers", async () => {
  const pairs = async (dir) => (await loadDir(dir)).map((each) => `${each.file}:${each.tier}`);
  expect(checkFiles.length).toBeGreaterThanOrEqual(2);
  expect(await pairs(FLOWS_DIR)).toEqual(await pairs(CHECKS_DIR));
});
