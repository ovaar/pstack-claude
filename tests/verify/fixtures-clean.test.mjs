// Fixtures are recordings from a developer's machine, committed to a public
// repository. Nothing in them may name that machine or its user.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURES, leaks, MAX_BYTES } from "./scrub.mjs";

const files = readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
const traces = files.filter((file) => file.endsWith(".jsonl"));

test("every recording the checker tests name is committed", () => {
  expect(traces.length).toBeGreaterThanOrEqual(5);
});

test.each(files.map((file) => [file.slice(FIXTURES.length + 1)]))("%s names no machine, user or account", (file) => {
  expect(leaks(readFileSync(join(FIXTURES, file), "utf8"))).toEqual([]);
});

// A stream that carries many user messages repeats its init event each time;
// a fixture keeps one.
test.each(traces.map((file) => [file.slice(FIXTURES.length + 1)]))("%s holds at most one init event", (file) => {
  const events = readFileSync(join(FIXTURES, file), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(events.filter((event) => event.subtype === "init").length).toBeLessThanOrEqual(1);
});

// Built at run time so that no scanner reads these lines as a leak.
const token = ["sk", "ant", "api03", "x".repeat(24)].join("-");
const address = ["someone", "example.com"].join("@");

test.each([
  ["a /Users/ path", '{"cwd":"/Users/someone/project"}'],
  ["a /Users/ path", '{"memory":"projects/-Users-someone-project/memory"}'],
  ["a /home/ path", '{"cwd":"/home/someone/project"}'],
  ["a temp directory of the recording machine", '{"cwd":"/private/var/folders/ab/cdef/T/run"}'],
  ["the local user name", '{"mount":"/Volumes/someone/project"}'],
  ["the local user name", '{"remote":"someone@build-box.local:project.git"}'],
  ["the machine name", '{"remote":"git@build-box.local:project.git"}'],
  ["an email address, a token-shaped string or a home path", `{"account":"${address}"}`],
  ["an email address, a token-shaped string or a home path", `{"key":"${token}"}`],
  [`more than ${MAX_BYTES} bytes`, "x".repeat(MAX_BYTES + 1)],
])("the scan reports %s", (finding, text) => {
  expect(leaks(text, "someone", "build-box.local")).toContain(finding);
});

// The account that runs these tests may be called user, claude, code or
// test, and its machine sandbox or local: all words of every recording.
const WORDS = '{"type":"user","model":"claude-haiku-5-5","skill":"pstack:principle-fix-root-causes","plugin":"pstack@inline","text":"run the test in a sandbox, local code only"}';

test.each([["user"], ["claude"], ["code"], ["test"], ["root"], ["sandbox"], ["local"]])("a word of the recordings is no leak when the account or the machine is called %s", (name) => {
  expect(leaks(WORDS, name, name)).toEqual([]);
});

// Whoever records knows their own name, so the tool that writes a fixture
// refuses it wherever it stands.
test("for the one who records, their name anywhere is a leak", () => {
  const text = '{"note":"written by someone on build-box"}';
  expect(leaks(text, "someone", "build-box")).toEqual([]);
  expect(leaks(text, "someone", "build-box", { strict: true })).toEqual(["the local user name", "the machine name"]);
  expect(leaks(WORDS, "root", "causes", { strict: true })).toEqual([]);
});
