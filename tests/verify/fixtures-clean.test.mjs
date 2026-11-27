// Fixtures are recordings from a developer's machine, committed to a public
// repository. Nothing in them may name that machine or its user.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_MODEL_CALLS } from "../../tools/verify/paths.mjs";
import { FIXTURES, leaks, MAX_BYTES, PLACEHOLDER, renumber, scrub } from "./scrub.mjs";

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

// A name that is not a generic word counts wherever it stands as a word, in
// any case: a signed-in trace prints it in a directory listing, in a sentence
// and in an owner column.
test.each([
  ["a sentence", '{"text":"written by someone on build-box"}'],
  ["capitals", '{"text":"Someone SOMEONE"}'],
  ["a possessive", '{"text":"someone\'s notes"}'],
  ["a directory listing", '{"text":"drwxr-xr-x 5 someone  staff 160 .\\n"}'],
  ["a machine name in any case", '{"text":"Build-Box answered"}'],
])("a name is a leak in %s, for any scan", (_, text) => {
  expect(leaks(text, "someone", "build-box")).not.toEqual([]);
  expect(leaks(text, "someone", "build-box", { strict: true })).not.toEqual([]);
});

test("the short label of a machine name is the machine name too", () => {
  expect(leaks('{"text":"on Build-Box"}', "someone", "build-box.local")).toEqual(["the machine name"]);
});

test.each([["somebody else"], ["awesomeone"], ["a fix-someone-else-branch"], ["someones"]])("a word that holds the name inside it is no leak: %s", (word) => {
  expect(leaks(`{"text":"${word}"}`, "someone", "build-box")).toEqual([]);
});

test.each([["user"], ["claude"], ["code"], ["test"], ["root"], ["admin"], ["runner"], ["sandbox"], ["local"], ["ubuntu"]])("the generic word %s is no leak anywhere", (name) => {
  expect(leaks(`{"text":"the ${name} account ran the ${name.toUpperCase()} ${name}"}`, name, name)).toEqual([]);
});

// A short name is no more English than a long one: only the generic words
// above are let through, so "tom" is found wherever it stands as a word.
test.each([
  ["a directory listing", '{"text":"drwxr-xr-x 5 tom  staff 160 .\\n"}'],
  ["a sentence", '{"text":"Tom wrote it"}'],
  ["capitals", '{"text":"TOM"}'],
])("a three-letter user name is a leak in %s", (_, text) => {
  expect(leaks(text, "tom", "build-box")).toEqual(["the local user name"]);
  expect(leaks(text, "tom", "build-box", { strict: true })).toEqual(["the local user name"]);
});

test("a three-letter name inside a longer word is no leak", () => {
  expect(leaks('{"text":"a tomato and a custom fix-tom-branch"}', "tom", "build-box")).toEqual([]);
});

// Whoever records knows their own name, so the tool that writes a fixture
// refuses it wherever it stands, and an organisation's name it was given.
test("for the one who records, their name anywhere is a leak", () => {
  const text = '{"note":"written by someone on build-box"}';
  expect(leaks(text, "someone", "build-box")).toEqual(["the local user name", "the machine name"]);
  expect(leaks(text, "someone", "build-box", { strict: true })).toEqual(["the local user name", "the machine name"]);
  expect(leaks(WORDS, "root", "causes", { strict: true })).toEqual([]);
  expect(leaks('{"org":"Acme Widgets"}', "someone", "build-box", { names: ["Acme"] })).toEqual(["a name from PSTACK_SCRUB_NAMES"]);
});

// Every id in a fixture is a placeholder of one shape, so none can be a real
// session, account or organisation.
test("every UUID-shaped string must carry the placeholder prefix", () => {
  expect(PLACEHOLDER).toBe("00000000-0000-4000-8000-");
  expect(leaks(`{"id":"${PLACEHOLDER}000000000007"}`, "someone", "build-box")).toEqual([]);
  for (const real of ["abcdef01-2345-4678-9abc-def012345678", "ABCDEF01-2345-4678-9ABC-DEF012345678", "00000000-0000-4000-8001-000000000001"]) {
    expect(leaks(`{"id":"${real}"}`, "someone", "build-box")).toContain("a UUID that is not a placeholder");
  }
});

// The API's request and message ids and a tool call's id name an account's
// usage on the server, as do a background agent's and a run's.
describe("server-side ids", () => {
  const real = { req: "req_011AAAAAAAAAAAAAAAAAAAAA", msg: "msg_011BBBBBBBBBBBBBBBBBBBBB", toolu: "toolu_01CCCCCCCCCCCCCCCCCCCCCC" };
  test.each(Object.entries(real))("a real %s id is a leak, a placeholder one is not", (_, id) => {
    expect(leaks(`{"id":"${id}"}`, "someone", "build-box")).toContain("a server-side id that is not a placeholder");
    expect(leaks(`{"id":"${renumber(id)}"}`, "someone", "build-box")).toEqual([]);
  });

  test.each([["agent_id"], ["task_id"], ["run_id"], ["agentId"]])("a real %s is a leak", (key) => {
    expect(leaks(`{"${key}":"a0b1c2d3e4f5a6b7c"}`, "someone", "build-box")).toContain("a server-side id that is not a placeholder");
    expect(leaks(`{"${key}":"${renumber(`{"${key}":"a0b1c2d3e4f5a6b7c"}`).match(/:"([^"]+)"/)[1]}"}`, "someone", "build-box")).toEqual([]);
  });

  test("renumbering keeps what links two events: one id, one placeholder, and a name that is no id is left", () => {
    const text = `${real.toolu} ${real.msg} ${real.toolu} msg_lifecycle_v1 "agent_id":"a0b1c2d3e4f5a6b7c" in /tasks/a0b1c2d3e4f5a6b7c.output`;
    const out = renumber(text);
    const [call, message, again] = out.split(" ");
    expect(call).toBe(again);
    expect(call).not.toBe(message);
    expect(out).toContain("msg_lifecycle_v1");
    expect(out.match(/"agent_id":"(\d+)"/)[1]).toBe(out.match(/tasks\/(\d+)\.output/)[1]);
    expect(renumber(out)).toBe(out);
  });

  test("a scrubbed signed-in trace carries none of them", () => {
    const line = JSON.stringify({ type: "assistant", request_id: real.req, message: { id: real.msg, content: [{ type: "tool_use", id: real.toolu }] }, agent_id: "a0b1c2d3e4f5a6b7c" });
    const out = scrub(`${line}\n`, "/s/stage", "/s/sandbox", { home: "/Users/someone", user: "someone", host: "build-box", tmp: [] });
    expect(leaks(out, "someone", "build-box", { strict: true })).toEqual([]);
    for (const id of [...Object.values(real), "a0b1c2d3e4f5a6b7c"]) expect(out).not.toContain(id);
  });

  test("the committed recordings hold no real one", () => {
    for (const file of traces) expect(leaks(readFileSync(file, "utf8"))).not.toContain("a server-side id that is not a placeholder");
  });
});

// A real run is held to MAX_MODEL_CALLS by the checker. The recordings are
// one such run, so they must be within it as well.
test("the recorded model-tier sessions together made no more calls than a run may", () => {
  const ids = new Set();
  for (const file of traces.filter((each) => /untouched\.B\d\.attempt-\d\.jsonl$/.test(each))) {
    const name = file.slice(FIXTURES.length + 1);
    for (const line of readFileSync(file, "utf8").trimEnd().split("\n")) {
      const event = JSON.parse(line);
      if (event.type === "assistant" && event.message?.id) ids.add(`${name}/${event.message.id}`);
    }
  }
  expect(ids.size).toBeLessThanOrEqual(MAX_MODEL_CALLS);
});

// What a signed-in session leaves in its stream, in the shape the CLI writes.
describe("scrub", () => {
  const machine = { home: "/Users/someone", user: "someone", host: "Build-Box.local", tmp: [] };
  const session = "abcdef01-2345-4678-9abc-def012345678";
  const lines = [
    { type: "system", subtype: "init", session_id: session, cwd: "/private/var/folders/ab/T/pstack-verify-x/B1/attempt-1/cwd", memory_paths: { auto: "/Users/someone/.claude/projects/-private-var-folders-ab-T-pstack-verify-x-B1-attempt-1-cwd/memory/" }, uuid: "11111111-2222-4333-8444-555555555555" },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.5 }, session_id: session },
    { type: "system", subtype: "thinking_tokens", session_id: session },
    { type: "system", subtype: "init", session_id: session, cwd: "again" },
    { type: "user", session_id: session, message: { content: [{ type: "tool_result", content: `drwxr-xr-x 5 someone staff 160 .\n${"x".repeat(3000)}\nmail someone@example.com org Acme Widgets` }] } },
    { type: "system", subtype: "hook_response", stdout: "x".repeat(2000), session_id: session },
  ];
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const out = scrub(text, "/private/var/folders/ab/T/stage-x", "/private/var/folders/ab/T/pstack-verify-x", machine, ["Acme"]);

  test("leaves nothing a scan of the recording machine would find", () => {
    expect(leaks(out, "someone", "Build-Box.local", { strict: true, names: ["Acme"] })).toEqual([]);
  });

  test("renumbers every id, so two events that shared one still do", () => {
    const events = out.trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].session_id).toBe(`${PLACEHOLDER}000000000001`);
    expect(events[0].uuid).toBe(`${PLACEHOLDER}000000000002`);
    expect(events.at(-1).session_id).toBe(events[0].session_id);
  });

  test("drops the account's usage, the progress noise and a second init, and cuts a very long text", () => {
    const events = out.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type + (event.subtype ? `/${event.subtype}` : ""))).toEqual(["system/init", "user", "system/hook_response"]);
    expect(events[1].message.content[0].content.length).toBeLessThan(1500);
    expect(events[1].message.content[0].content).toContain("more characters left out");
    // What a check reads whole stays whole.
    expect(events[2].stdout.length).toBe(2000);
  });
});
