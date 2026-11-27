// The three roles stay apart only while their modules do. A checker that
// could start a process could rerun what it judges, one that could write
// could launder the evidence it reads, and a driver that read the checks
// could shape its runs to pass them.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { CHECKS_DIR, checkShape, FLOWS_DIR, flowShape, loadDir } from "../../tools/verify/paths.mjs";
import { FIXTURES } from "./scrub.mjs";

const VERIFY = dirname(CHECKS_DIR);
const read = (file) => readFileSync(join(VERIFY, file), "utf8");
const modules = readdirSync(VERIFY, { recursive: true })
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => file.split("\\").join("/"))
  .sort();
const checkFiles = modules.filter((file) => file.startsWith("checks/"));

const startsProcesses = (source) => /child_process|\bBun\s*\.\s*(?:spawn|\$)/.test(source);
const imports = (source) => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);

// What a module can do to the file system: the names it imports from
// node:fs, and `*` for every way of reaching the file system whose calls a
// scan of the import list cannot name.
function fsAccess(source) {
  const named = [...source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs["']/g)].flatMap((match) => match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]));
  const opaque = /\bimport\s+(?:\*\s*as\s+)?\w+\s*(?:,\s*\{[^}]*\}\s*)?from\s*["'](?:node:)?fs["']|\bimport\s*\(\s*["'](?:node:)?fs|["'](?:node:)?fs\/promises["']|\brequire\s*\(|\bBun\s*\.\s*(?:write|file)\b/.test(source);
  return [...named.filter(Boolean), ...(opaque ? ["*"] : [])].sort();
}

const READS = ["existsSync", "lstatSync", "readFileSync", "readdirSync", "readlinkSync", "realpathSync"];
const beyond = (allowed) => (file) => fsAccess(read(file)).filter((name) => !allowed.includes(name));

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

test("the scan sees every way a module can reach the file system", () => {
  expect(fsAccess('import { existsSync, writeFileSync as put } from "node:fs";')).toEqual(["existsSync", "writeFileSync"]);
  expect(fsAccess('import { rmSync } from "fs";')).toEqual(["rmSync"]);
  for (const hidden of ['import fs from "node:fs";', 'import * as fs from "node:fs";', 'import fs, { readFileSync } from "node:fs";', 'const fs = await import("node:fs");', 'import { writeFile } from "node:fs/promises";', 'const fs = require("node:fs");', "await Bun.write(path, text);"]) {
    expect(fsAccess(hidden)).toContain("*");
  }
});

test("only setup and the driver can start a process", () => {
  expect(modules.filter((file) => startsProcesses(read(file)))).toEqual(["drive.mjs", "setup.mjs"]);
});

test("the checker reaches neither of them through its imports", () => {
  expect([...reach("check.mjs")].sort()).toEqual(["../plugin.mjs", "check.mjs", "paths.mjs", "stage.mjs", "trace.mjs"]);
  expect(startsProcesses(read("../plugin.mjs"))).toBe(false);
});

// A checker that rewrote setup.json with the stage's present hash would pass
// an edited stage on the next rerun.
test("the checker, and every module it reaches, only reads the file system", () => {
  expect([...reach("check.mjs")].filter((file) => beyond(READS)(file).length)).toEqual([]);
});

test("the driver imports no check, no checker and no trace reader", () => {
  expect(imports(read("drive.mjs")).filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
});

// It saves traces, so it writes. It has no call that changes a file's mode
// or removes one, which is what turning the stage into a passing one for the
// length of a session takes; the stage's seal is what catches a write.
test("the driver reads, makes directories and writes files, and nothing else", () => {
  expect(beyond([...READS, "mkdirSync", "writeFileSync"])("drive.mjs")).toEqual([]);
});

// A check gets its traces and the stage handed in. One that imported a
// module, or read the process, could look past them at the working tree.
test.each(checkFiles.map((file) => [file]))("%s imports nothing and reads no global state", (file) => {
  const source = read(file);
  expect(imports(source)).toEqual([]);
  expect(source).not.toMatch(/\brequire\s*\(|\bprocess\s*\.|\bBun\s*\.|\bglobalThis\b|\bfetch\s*\(/);
});

test("flows/ and checks/ hold the same checks, in the same tiers, with the same arguments for every run", async () => {
  const [flows, checks] = [await loadDir(FLOWS_DIR), await loadDir(CHECKS_DIR)];
  expect(checks.length).toBeGreaterThanOrEqual(2);
  expect(flows.map(flowShape)).toEqual(checks.map(checkShape));
});

// A check is added as files of its own: a flow, a check, a recording of
// every run on the untouched tree, and a test file. This is the one test
// that says which of them is missing.
test("every shipped check has an untouched recording of each of its runs, and a test file", async () => {
  const wanted = (await loadDir(FLOWS_DIR)).flatMap((flow) => [...flow.runs.map((run) => join(FIXTURES, `untouched.${flow.id}.${run.name}.jsonl`)), join(import.meta.dir, "checks", flow.file.replace(/\.mjs$/, ".test.mjs"))]);
  expect(wanted.filter((file) => !existsSync(file))).toEqual([]);
});
