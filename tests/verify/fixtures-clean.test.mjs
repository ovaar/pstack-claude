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
  ["the local user name", '{"user":"someone"}'],
  ["the machine name", '{"host":"build-box.local"}'],
  ["an email address, a token-shaped string or a home path", `{"account":"${address}"}`],
  ["an email address, a token-shaped string or a home path", `{"key":"${token}"}`],
  [`more than ${MAX_BYTES} bytes`, "x".repeat(MAX_BYTES + 1)],
])("the scan reports %s", (finding, text) => {
  expect(leaks(text, "someone", "build-box.local")).toContain(finding);
});

test("the scan leaves a name inside a longer identifier alone", () => {
  expect(leaks('{"skill":"pstack:principle-fix-root-causes","plugin":"pstack@inline"}', "root", "build-box.local")).toEqual([]);
});
