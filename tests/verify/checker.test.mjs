// The checker itself over recorded traces, with no CLI and no model call:
// the integrity rules every trace is held to, the verdicts, the word that
// leads the line, and the observations. It judges by the two checks under
// engine/, never by a shipped one, so a new or changed check moves no test
// here; each shipped check has its own file under checks/. A doctored trace
// starts from an untouched recording and changes one fact, and must turn
// exactly the rule that guards that fact.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../tools/verify/check.mjs";
import { cleanup, ENGINE, evidence, tempDir } from "./harness.mjs";

const MANDATE = "plugins/pstack/hooks/session-start-context.md";
const SCRIPT = "plugins/pstack/hooks/session-start.sh";

afterEach(cleanup);

const judge = (edits) => check(evidence(ENGINE, edits), ENGINE.checks);
const init = (events) => events.find((event) => event.subtype === "init");
const hook = (events) => events.find((event) => event.subtype === "hook_response");
const result = (events) => events.find((event) => event.type === "result");
const pstack = (events) => init(events).plugins.find((plugin) => plugin.name === "pstack");

const verdicts = (judged) => Object.fromEntries(judged.checks.map((each) => [each.id, each.verdict]));
const failed = (judged) => judged.checks.flatMap((each) => each.failed ?? []);
const observed = (judged) => judged.checks.flatMap((each) => (each.observations ?? []).map((seen) => `${each.id} ${seen.text}`));
const said = (judged, id) => {
  const [checkId, ...rest] = id.split(".");
  const each = judged.checks.find((candidate) => candidate.id === checkId);
  const item = [...each.integrity, ...each.assertions].find((candidate) => candidate.id === rest.join("."));
  return `saw ${item.saw}, want ${item.want}`;
};

test("an untouched run passes every rule with nothing to observe", async () => {
  const judged = await judge();
  expect(judged.line).toBe("PASS surface 2/2 | behavior NOT BUILT | round 1");
  expect(verdicts(judged)).toEqual({ E1: "pass", E2: "pass" });
  expect(failed(judged)).toEqual([]);
  expect(observed(judged)).toEqual([]);
  expect(judged.cost_usd).toBe(0);
  expect(judged.checks[0].integrity.map((rule) => rule.id.replace("context.", ""))).toEqual([
    "stage-hash",
    "stage-seal",
    "trace-sha256",
    "argv",
    "init-present",
    "result-present",
    "cwd",
    "plugin-once",
    "plugin-path",
    "plugin-source",
    "plugin-version",
    "zero-cost",
    "no-model",
  ]);
});

describe("one doctored trace per integrity rule", () => {
  const settings = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "cat mandate.md" }] }] } });
  const cases = [
    ["E1.context.trace-sha256", { E1: { sidecar: { trace_sha256: "0".repeat(64) } } }],
    ["E1.context.argv", { E1: { argv: (argv) => [...argv, "--bare"] } }],
    ["E1.context.argv", { E1: { argv: (argv) => [...argv, "--safe-mode"] } }],
    // A hook of the driver's own making, in place of the plugin's.
    ["E1.context.argv", { E1: { argv: (argv) => [...argv, "--settings", settings] } }],
    ["E1.context.argv", { E1: { argv: (argv) => argv.filter((arg) => arg !== "/context") } }],
    ["E1.context.argv", { E1: { argv: (argv) => ["/opt/another/claude", ...argv.slice(1)] } }],
    ["E1.context.init-present", { E1: { events: (events) => events.filter((event) => event.subtype !== "init") } }],
    ["E1.context.result-present", { E1: { events: (events) => events.filter((event) => event.type !== "result") } }],
    ["E1.context.cwd", { E1: { events: (events) => void (init(events).cwd = "/a/project/with/hooks/of/its/own") } }],
    ["E1.context.plugin-once", { E1: { events: (events) => void init(events).plugins.push({ ...pstack(events) }) } }],
    ["E1.context.plugin-path", { E1: { events: (events) => void (pstack(events).path = "/opt/elsewhere/plugins/pstack") } }],
    ["E1.context.plugin-source", { E1: { events: (events) => void (pstack(events).source = "pstack@pstack-claude") } }],
    ["E1.context.plugin-version", { E1: { events: (events) => void (pstack(events).version = "0.0.0") } }],
    ["E1.context.zero-cost", { E1: { events: (events) => void (result(events).total_cost_usd = 0.0028) } }],
    ["E1.context.no-model", { E1: { events: (events) => void (result(events).modelUsage = { "claude-haiku-5-5": { costUSD: 0 } }) } }],
    ["E1.context.no-model", { E1: { events: (events) => void (events.find((event) => event.type === "assistant").message.model = "claude-haiku-5-5") } }],
    ["E2.hook", { E2: { events: (events) => void (hook(events).exit_code = 126) } }],
  ];

  test.each(cases)("%s fails alone", async (id, edits) => {
    const judged = await judge(edits);
    expect(failed(judged)).toEqual([id]);
    expect(judged.verdict).toBe("FAIL");
    expect(verdicts(judged)).toEqual({ E1: "pass", E2: "pass", [id.slice(0, 2)]: "fail" });
  });

  test("the argv rule names every token it saw and every token it wanted", async () => {
    const judged = await judge({ E1: { argv: (argv) => [...argv, "--settings", settings] } });
    expect(said(judged, "E1.context.argv")).toMatch(/^saw argv \["claude","-p","--plugin-dir",".*\/plugins\/pstack","--model","haiku","--output-format","stream-json","--verbose","\/context","--settings",".*"\], want exactly \["claude","-p","--plugin-dir",".*\/plugins\/pstack","--model","haiku","--output-format","stream-json","--verbose","\/context"\]$/);
  });

  test("a trace of a run the check declares no arguments for fails argv, and setup planned no such run", async () => {
    const stray = { check: "E1", name: "extra", args: ["/context"], fixture: "untouched.S2.context" };
    const dir = evidence({ ...ENGINE, runs: [...ENGINE.runs, stray] }, { setup: { sessions: [] } });
    const judged = await check(dir, ENGINE.checks);
    expect(failed(judged)).toEqual(["E1.context.cwd", "E1.extra.argv", "E1.extra.cwd", "E2.startup.cwd"]);
    expect(said(judged, "E1.extra.argv")).toEndWith("want a run the check file declares arguments for, and it declares none for extra");
    expect(said(judged, "E1.extra.cwd")).toEndWith("want a run setup planned, and it planned none named extra");
  });

  // One stage serves every trace of a run, so a moved stage fails them all.
  test("a stage edited after setup fails stage-hash on every trace", async () => {
    const judged = await judge({ moved: (stage) => writeFileSync(join(stage, "plugins/pstack/README.md"), "edited after the drive\n") });
    expect(failed(judged)).toEqual(["E1.context.stage-hash", "E1.context.stage-seal", "E2.startup.stage-hash", "E2.startup.stage-seal"]);
    expect(said(judged, "E1.context.stage-hash")).toMatch(/^saw stage hash [0-9a-f]{64}, want the stage hash setup recorded, [0-9a-f]{64}$/);
  });

  test.skipIf(process.platform === "win32")("a file mode changed in the stage moves the stage hash too", async () => {
    const judged = await judge({ moved: (stage) => chmodSync(join(stage, MANDATE), 0o755) });
    expect(failed(judged)).toContain("E1.context.stage-hash");
  });

  // What a driver does to get a broken hook past one session: the stage hash
  // is the same before and after.
  test.skipIf(process.platform === "win32")("a file changed for a while and put back fails stage-seal alone", async () => {
    const script = (stage) => join(stage, SCRIPT);
    const judged = await judge({
      stage: (stage) => writeFileSync(script(stage), "#!/bin/sh\n", { mode: 0o644 }),
      moved: (stage) => {
        chmodSync(script(stage), 0o755);
        chmodSync(script(stage), 0o644);
      },
    });
    expect(failed(judged)).toEqual(["E1.context.stage-seal", "E2.startup.stage-seal"]);
    expect(said(judged, "E1.context.stage-seal")).toBe("saw an entry of the stage changed since setup, or was changed and put back, want every entry of the stage as setup left it");
  });

  test("a stage that is gone fails stage-hash and says what to do", async () => {
    const judged = await judge({ moved: (stage) => rmSync(stage, { recursive: true }) });
    expect(failed(judged)).toContain("E2.startup.stage-hash");
    expect(failed(judged)).not.toContain("E2.startup.stage-seal");
    expect(said(judged, "E2.startup.stage-hash")).toStartWith("saw the stage is gone; run the verifier again, want the stage hash setup recorded");
  });
});

describe("traces a driver must not get past the checker", () => {
  test("a session that loaded the installed copy is the wrong tree", async () => {
    const installed = { name: "pstack", path: "/Users/someone/.claude/plugins/cache/pstack-claude/pstack/0.9.158", source: "pstack@pstack-claude", version: "0.9.158" };
    const judged = await judge({ E1: { events: (events) => void Object.assign(pstack(events), installed) } });
    expect(verdicts(judged)).toEqual({ E1: "fail", E2: "pass" });
    expect(failed(judged)).toEqual(["E1.context.plugin-path", "E1.context.plugin-source"]);
    expect(said(judged, "E1.context.plugin-path")).toStartWith(`saw plugin path ${installed.path}, want the stage's plugin directory, `);
  });

  test("a stream cut off before its result event fails, and the cut line is observed", async () => {
    const cut = (text) => text.slice(0, text.trimEnd().lastIndexOf("\n") + 40);
    const judged = await judge({ E1: { raw: cut } });
    expect(verdicts(judged)).toEqual({ E1: "fail", E2: "pass" });
    expect(failed(judged)).toEqual(["E1.context.result-present"]);
    expect(observed(judged)).toEqual(["E1 1 stream lines are not JSON"]);
  });

  test("the process exit code changes no verdict in either direction", async () => {
    const crashed = { exit_code: 1, signal: "SIGKILL" };
    expect(verdicts(await judge({ E1: { sidecar: crashed }, E2: { sidecar: crashed } }))).toEqual({ E1: "pass", E2: "pass" });
    const clean = { exit_code: 0 };
    expect(verdicts(await judge({ E2: { fixture: "hook-not-executable.S3.startup", sidecar: clean } }))).toEqual({ E1: "pass", E2: "fail" });
  });
});

// The check files are part of what a run was judged by. A rerun of the
// checker must not judge by fewer or by other ones under the run's name.
describe("check files that changed after the run", () => {
  function ownChecks() {
    const checks = tempDir();
    cpSync(ENGINE.checks, checks, { recursive: true });
    return { checks, dir: evidence({ ...ENGINE, checks }) };
  }

  test("a deleted check file is an error for its check, not one check fewer", async () => {
    const { checks, dir } = ownChecks();
    rmSync(join(checks, "E2-ran-a-hook.mjs"));
    const judged = await check(dir, checks);
    expect(judged.line).toBe("FAIL surface 1/1 | behavior NOT BUILT | round 1");
    expect(judged.checks[1]).toMatchObject({ id: "E2", verdict: "error", reason: "no check file for E2; the run was judged by E2-ran-a-hook.mjs" });
  });

  test("a changed check file is an error for its check", async () => {
    const { checks, dir } = ownChecks();
    writeFileSync(join(checks, "E2-ran-a-hook.mjs"), 'export const title = "asks nothing";\nexport const tier = "surface";\nexport const assertions = () => [];\n');
    const judged = await check(dir, checks);
    expect(judged.verdict).toBe("FAIL");
    expect(verdicts(judged)).toEqual({ E1: "pass", E2: "error" });
    expect(judged.checks[1].reason).toBe("E2-ran-a-hook.mjs changed after the run; run the verifier again");
  });

  test("a check file added after the run was not run, so the rerun is no pass", async () => {
    const { checks, dir } = ownChecks();
    writeFileSync(join(checks, "E3-new.mjs"), 'export const title = "new";\nexport const tier = "surface";\nexport const assertions = () => [];\n');
    const judged = await check(dir, checks);
    expect(judged.line).toBe("PARTIAL surface 2/3 | behavior NOT BUILT | round 1");
    expect(judged.checks[2]).toMatchObject({ id: "E3", verdict: "skipped", reason: "not selected" });
  });

  test("a selected check and a trace directory both need a check file", async () => {
    const dir = evidence(ENGINE, { setup: { selected: ["E1", "E2", "E7"] } });
    mkdirSync(join(dir, "traces", "E9"));
    const judged = await check(dir, ENGINE.checks);
    expect(judged.verdict).toBe("FAIL");
    expect(verdicts(judged)).toEqual({ E1: "pass", E2: "pass", E7: "error", E9: "error" });
    expect(judged.checks[3].reason).toBe("no check file for E9");
  });

  test("a check the run has no record of is not judged", async () => {
    const judged = await judge({ setup: { checks: [] } });
    expect(verdicts(judged)).toEqual({ E1: "error", E2: "error" });
    expect(judged.checks[0].reason).toBe("E1-reports-plugins.mjs was not there at the run; run the verifier again");
  });
});

describe("verdicts and the word that leads the line", () => {
  test("a missing trace is unobservable and counts as failed", async () => {
    const judged = await judge({ E2: { absent: true } });
    expect(judged.line).toBe("FAIL surface 1/2 | behavior NOT BUILT | round 1");
    expect(judged.checks[1]).toMatchObject({ id: "E2", verdict: "unobservable", reason: "the startup trace is missing", failed: [] });
  });

  test("a trace without the record a check judges is unobservable", async () => {
    const judged = await judge({ E2: { events: (events) => events.filter((event) => !event.subtype?.startsWith("hook_")) } });
    expect(judged.verdict).toBe("FAIL");
    expect(judged.checks[1]).toMatchObject({ verdict: "unobservable", reason: "a hook_response is missing" });
  });

  test("a run that left a check out is PARTIAL, whatever the rest did", async () => {
    const judged = await judge({ setup: { selection: { tier: "all", flow: "E1" }, selected: ["E1"] }, E2: { absent: true } });
    expect(judged.line).toBe("PARTIAL surface 1/2 | behavior NOT BUILT | round 1");
    expect(judged.checks[1]).toMatchObject({ id: "E2", verdict: "skipped", reason: "not selected" });
  });

  test("a run that selected nothing is SKIPPED", async () => {
    const judged = await judge({ setup: { selection: { tier: "behavior", flow: null }, selected: [] } });
    expect(judged.line).toBe("SKIPPED surface NOT RUN | behavior NOT BUILT | round 1");
  });

  const cli = (fields) => ({ path: "claude", real_path: "/opt/claude/2.1.332", sha256: "c".repeat(64), version: "2.1.332", stand_in: null, missing: false, required: false, problem: null, ...fields });

  test.each([["named by PSTACK_VERIFY_CLAUDE"], ['calls itself "2.1.332 (stand-in for tests)"']])("a run against a CLI %s is STAND-IN, never PASS", async (standIn) => {
    const judged = await judge({ setup: { cli: cli({ stand_in: standIn }) } });
    expect(judged.line).toBe("STAND-IN surface 2/2 | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ E1: "pass", E2: "pass" });
    expect(judged.cli_stand_in).toBe(standIn);
  });

  test("a failure against a stand-in is still FAIL", async () => {
    const judged = await judge({ setup: { cli: cli({ stand_in: "named by PSTACK_VERIFY_CLAUDE" }) }, E2: { fixture: "hook-not-executable.S3.startup" } });
    expect(judged.line).toBe("FAIL surface 1/2 | behavior NOT BUILT | round 1");
  });

  const none = (fields) => ({ setup: { cli: cli({ path: null, real_path: null, sha256: null, version: null, ...fields }), sessions: [] }, E1: { absent: true }, E2: { absent: true } });

  test("no CLI skips every check and names the reason first", async () => {
    const judged = await judge(none({ missing: true, problem: "claude is not on PATH" }));
    expect(judged.line).toBe("SKIPPED surface: claude is not on PATH | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ E1: "skipped", E2: "skipped" });
  });

  test("no CLI where one is required is an error", async () => {
    const judged = await judge(none({ missing: true, required: true, problem: "claude is not on PATH" }));
    expect(judged.line).toBe("FAIL surface: claude is not on PATH | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ E1: "error", E2: "error" });
  });

  test("a CLI named through the environment that is not there is an error, not an absent CLI", async () => {
    const problem = "PSTACK_VERIFY_CLAUDE does not name an executable";
    const judged = await judge(none({ problem }));
    expect(judged.line).toBe(`FAIL surface: ${problem} | behavior NOT BUILT | round 1`);
    expect(verdicts(judged)).toEqual({ E1: "error", E2: "error" });
  });

  test("a CLI older than the minimum is an error", async () => {
    const problem = "claude 2.1.245 is older than the minimum 2.1.332";
    const judged = await judge(none({ path: "claude", version: "2.1.245", problem }));
    expect(judged.line).toBe(`FAIL surface: ${problem} | behavior NOT BUILT | round 1`);
    expect(verdicts(judged)).toEqual({ E1: "error", E2: "error" });
  });

  function checksWith(file, source) {
    const checks = tempDir();
    writeFileSync(join(checks, file), source);
    return checks;
  }

  test("a check that reads no trace does not pass when no trace was recorded", async () => {
    const checks = checksWith("S9-asks-nothing.mjs", 'export const title = "asks nothing";\nexport const tier = "surface";\nexport const assertions = () => [];\n');
    const judged = await check(evidence({ checks, runs: [] }, { setup: { selected: ["S9"] } }), checks);
    expect(judged.line).toBe("FAIL surface 0/1 | behavior NOT BUILT | round 1");
    expect(judged.checks[0]).toMatchObject({ verdict: "unobservable", reason: "every trace is missing" });
  });

  test("a check that throws is an error, and its tier is counted", async () => {
    const checks = checksWith("B9-throws.mjs", 'export const title = "throws";\nexport const tier = "behavior";\nexport function assertions() {\n  throw new TypeError("boom");\n}\n');
    const judged = await check(evidence({ checks, runs: [] }, { setup: { selected: ["B9"] } }), checks);
    expect(judged.line).toBe("FAIL surface NOT BUILT | behavior 0/1 | round 1");
    expect(judged.checks[0].verdict).toBe("error");
    expect(judged.checks[0].reason).toStartWith("TypeError: boom");
  });
});

describe("observations", () => {
  const cases = [
    ["E1 2 SessionStart hook responses in one session", { E1: { events: (events) => [hook(events), ...events] } }],
    ["E1 hook SessionStart:startup wrote to stderr: warning: slow disk", { E1: { events: (events) => void (hook(events).stderr = "warning: slow disk\nsecond line\n") } }],
    ["E1 plugins beside pstack and the built-ins: other@market", { E1: { events: (events) => void init(events).plugins.push({ name: "other", path: "/opt/other", source: "other@market" }) } }],
    ["E1 MCP servers in init: github", { E1: { events: (events) => void (init(events).mcp_servers = [{ name: "github", status: "connected" }]) } }],
    ["E1 CLI 2.1.400; the checks were verified on 2.1.332", { E1: { events: (events) => void (init(events).claude_code_version = "2.1.400") } }],
    // The shape of the transcript's own record of the hook, read from a 2.1.332 session.
    ["E1 hook SessionStart:startup took 1500 ms", { E1: { transcript: `${JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "SessionStart:startup", exitCode: 0, durationMs: 1500 } })}\n` } }],
    ["E1 the session wrote to stderr: warning: no network", { E1: { stderr: "warning: no network\nsecond line\n" } }],
    ["E1 the driver stopped the session at its time limit", { E1: { sidecar: { timed_out: true } } }],
  ];

  test.each(cases)("%s, and the check still passes", async (text, edits) => {
    const judged = await judge(edits);
    expect(observed(judged)).toEqual([text]);
    expect(verdicts(judged)).toEqual({ E1: "pass", E2: "pass" });
  });

  // Without these a reader of the evidence sees `no init event` and cannot
  // tell a broken plugin from a CLI that refused its arguments.
  test("a session that left no events is observed with what the CLI said", async () => {
    const judged = await judge({ E1: { raw: () => "", stderr: "error: unknown option '--plugin-dir'\n" } });
    expect(failed(judged)).toEqual(["E1.context.init-present", "E1.context.result-present"]);
    expect(observed(judged)).toEqual(["E1 the session wrote to stderr: error: unknown option '--plugin-dir'"]);
  });

  test("a CLI that could not be started is observed", async () => {
    const judged = await judge({ E1: { raw: () => "", sidecar: { spawn_error: "spawn claude ENOENT" } } });
    expect(observed(judged)).toEqual(["E1 the CLI did not start: spawn claude ENOENT"]);
  });
});
