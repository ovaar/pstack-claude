// The integrity rules that only some runs have: a subcommand's output has to
// be one document about the directory it was given, and a run is held to the
// variables and the files its check declares. Judged by the two checks under
// engine-runs/, not by a shipped one.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { check } from "../../tools/verify/check.mjs";
import { cleanup, evidence } from "./harness.mjs";

afterEach(cleanup);

const CHECKS = join(import.meta.dir, "engine-runs");
const INPUT = ["--input-format", "stream-json"];
const RUNS = {
  checks: CHECKS,
  runs: [
    { check: "E3", name: "validate", command: ["plugin", "validate", "--json", "<plugin>"], fixture: "untouched.S1.validate" },
    { check: "E4", name: "startup", args: INPUT, env: { PSTACK_SESSION_HOOK: "off" }, files: { "pstack-models.md": "session hook: off\n" }, fixture: "untouched.S3.startup" },
  ],
};

const judge = (edits) => check(evidence(RUNS, edits), CHECKS);
const failed = (judged) => judged.checks.flatMap((each) => each.failed ?? []);
const said = (judged, id) => {
  const [checkId, ...rest] = id.split(".");
  const each = judged.checks.find((candidate) => candidate.id === checkId);
  const item = [...each.integrity, ...each.assertions].find((candidate) => candidate.id === rest.join("."));
  return `saw ${item.saw}, want ${item.want}`;
};

test("an untouched subcommand run and a session with extras pass, and the subcommand has no session rule", async () => {
  const judged = await judge();
  expect(failed(judged)).toEqual([]);
  expect(judged.line).toStartWith("PASS surface 2/2");
  const [validate, startup] = judged.checks.map((each) => each.integrity.map((rule) => rule.id.split(".")[1]));
  expect(validate).toEqual(["stage-hash", "stage-seal", "trace-sha256", "argv", "extras", "document", "target"]);
  expect(startup).toContain("extras");
  expect(startup).toContain("zero-cost");
});

describe("a subcommand run", () => {
  test("a document about another directory fails target alone", async () => {
    const judged = await judge({ E3: { events: ([report]) => void (report.target = "/elsewhere/plugins/pstack/.claude-plugin/plugin.json") } });
    expect(failed(judged)).toEqual(["E3.validate.target"]);
    expect(said(judged, "E3.validate.target")).toMatch(/^saw target \/elsewhere\/plugins\/pstack\/.claude-plugin\/plugin.json, want a manifest under .*\/plugins\/pstack\/.claude-plugin\/$/);
  });

  test("output that is not one JSON document fails document, and the check has nothing to judge", async () => {
    const judged = await judge({ E3: { raw: () => "Error: plugin not found\n" } });
    expect(failed(judged)).toEqual(["E3.validate.document"]);
    expect(judged.checks.find((each) => each.id === "E3")).toMatchObject({ verdict: "fail", reason: "the validator's document is missing" });
  });

  test("a flag the check did not declare fails argv alone", async () => {
    const judged = await judge({ E3: { argv: (argv) => [...argv, "--strict"] } });
    expect(failed(judged)).toEqual(["E3.validate.argv"]);
  });

  test("a subcommand started in place of the one declared fails argv alone", async () => {
    const judged = await judge({ E3: { argv: (argv) => ["claude", "plugin", "list", "--json", argv.at(-1)] } });
    expect(failed(judged)).toEqual(["E3.validate.argv"]);
  });
});

describe("what a run adds to its sandbox", () => {
  test("a variable that reached a run that declares none fails extras alone", async () => {
    const judged = await judge({ E3: { sidecar: { env: ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "PSTACK_SESSION_HOOK"] } } });
    expect(failed(judged)).toEqual(["E3.validate.extras"]);
    expect(said(judged, "E3.validate.extras")).toContain("PSTACK_SESSION_HOOK are no variable of a session");
  });

  test("a variable that the check declares and the session did not get fails extras alone", async () => {
    const judged = await judge({ E4: { sidecar: { env: ["CLAUDE_CONFIG_DIR", "HOME", "PATH"] } } });
    expect(failed(judged)).toEqual(["E4.startup.extras"]);
  });

  test("a sidecar with no environment fails extras alone", async () => {
    const judged = await judge({ E4: { sidecar: { env: undefined } } });
    expect(failed(judged)).toEqual(["E4.startup.extras"]);
    expect(said(judged, "E4.startup.extras")).toStartWith("saw no environment in the sidecar");
  });

  test("a sheet that is not the declared text fails extras alone", async () => {
    const judged = await judge({ setup: (setup) => ({ sessions: setup.sessions.map((session) => (session.check === "E4" ? { ...session, files: { "pstack-models.md": "0".repeat(64) } } : session)) }) });
    expect(failed(judged)).toEqual(["E4.startup.extras"]);
  });

  test("a switch that setup did not record fails extras alone", async () => {
    const judged = await judge({ setup: (setup) => ({ sessions: setup.sessions.map((session) => ({ ...session, env: {} })) }) });
    expect(failed(judged)).toEqual(["E4.startup.extras"]);
  });
});
