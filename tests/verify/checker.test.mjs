// The checker over recorded traces, with no CLI and no model call. Each
// fixture is the stream of a real zero-model run, scrubbed by scrub.mjs.
// A doctored trace starts from the untouched recording and changes one fact,
// and must turn exactly the assertion that guards that fact.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../tools/verify/check.mjs";
import { cleanup, evidence, tempDir } from "./harness.mjs";

const MANDATE = "plugins/pstack/hooks/session-start-context.md";

afterEach(cleanup);

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

describe("recorded traces", () => {
  test("the untouched tree passes both checks with nothing to observe", async () => {
    const judged = await check(evidence());
    expect(judged.line).toBe("PASS surface 2/2 | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ S2: "pass", S3: "pass" });
    expect(failed(judged)).toEqual([]);
    expect(observed(judged)).toEqual([]);
    expect(judged.cost_usd).toBe(0);
    expect(judged.checks.map((each) => each.integrity.length)).toEqual([11, 11]);
  });

  test("a hook script that lost its executable bit fails S3 on exit_code 126", async () => {
    const judged = await check(evidence({ S3: { fixture: "hook-not-executable" } }));
    expect(judged.line).toBe("FAIL surface 1/2 | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ S2: "pass", S3: "fail" });
    expect(failed(judged)).toEqual(["S3.exit-code", "S3.outcome", "S3.stdout", "S3.stderr"]);
    expect(said(judged, "S3.exit-code")).toBe("saw exit_code 126, want exit_code 0");
  });

  test("a deleted mandate file fails S3 on exit_code 1", async () => {
    const judged = await check(evidence({ stage: (stage) => rmSync(join(stage, MANDATE)), S3: { fixture: "mandate-missing" } }));
    expect(verdicts(judged)).toEqual({ S2: "pass", S3: "fail" });
    expect(failed(judged)).toEqual(["S3.exit-code", "S3.outcome", "S3.stdout", "S3.stderr"]);
    expect(said(judged, "S3.exit-code")).toBe("saw exit_code 1, want exit_code 0");
    expect(said(judged, "S3.stdout")).toEndWith("want the stage's hooks/session-start-context.md, which is not there");
  });

  test("a dependency the loader cannot satisfy fails S2 on plugin_errors", async () => {
    const judged = await check(evidence({ S2: { fixture: "dependency-unsatisfied" } }));
    expect(verdicts(judged)).toEqual({ S2: "fail", S3: "pass" });
    expect(failed(judged)).toEqual(["S2.context.plugin-once", "S2.plugin-errors"]);
    expect(said(judged, "S2.plugin-errors")).toBe("saw plugin_errors dependency-unsatisfied (pstack@inline), want no plugin_errors");
    expect(said(judged, "S2.context.plugin-once")).toBe("saw 0 plugins named pstack in init.plugins, want exactly 1");
  });
});

describe("one doctored trace per assertion", () => {
  const cases = [
    ["S2.context.trace-sha256", { S2: { sidecar: { trace_sha256: "0".repeat(64) } } }],
    ["S2.context.argv", { S2: { sidecar: { argv: ["claude", "-p", "--bare"] } } }],
    ["S2.context.argv", { S2: { sidecar: { argv: ["claude", "-p", "--safe-mode"] } } }],
    ["S2.context.init-present", { S2: { events: (events) => events.filter((event) => event.subtype !== "init") } }],
    ["S2.context.result-present", { S2: { events: (events) => events.filter((event) => event.type !== "result") } }],
    ["S2.context.plugin-once", { S2: { events: (events) => void init(events).plugins.push({ ...pstack(events) }) } }],
    ["S2.context.plugin-path", { S2: { events: (events) => void (pstack(events).path = "/opt/elsewhere/plugins/pstack") } }],
    ["S2.context.plugin-source", { S2: { events: (events) => void (pstack(events).source = "pstack@pstack-claude") } }],
    ["S2.context.plugin-version", { S2: { events: (events) => void (pstack(events).version = "0.0.0") } }],
    ["S2.context.zero-cost", { S2: { events: (events) => void (result(events).total_cost_usd = 0.0028) } }],
    ["S2.context.no-model", { S2: { events: (events) => void (result(events).modelUsage = { "claude-haiku-5-5": { costUSD: 0 } }) } }],
    ["S2.context.no-model", { S2: { events: (events) => void (events.find((event) => event.type === "assistant").message.model = "claude-haiku-5-5") } }],
    ["S2.plugin-errors", { S2: { events: (events) => void (init(events).plugin_errors = [{ plugin: "inline[0]", type: "path-not-found", message: "gone" }]) } }],
    ["S3.one-response", { S3: { events: (events) => [hook(events), ...events] } }],
    ["S3.exit-code", { S3: { events: (events) => void (hook(events).exit_code = 126) } }],
    ["S3.outcome", { S3: { events: (events) => void (hook(events).outcome = "error") } }],
    ["S3.stdout", { S3: { events: (events) => void (hook(events).stdout += " ") } }],
    ["S3.stderr", { S3: { events: (events) => void (hook(events).stderr = "warning: slow disk\n") } }],
  ];

  test.each(cases)("%s fails alone", async (id, edits) => {
    const judged = await check(evidence(edits));
    expect(failed(judged)).toEqual([id]);
    expect(judged.verdict).toBe("FAIL");
    const other = id.startsWith("S2") ? "S3" : "S2";
    expect(verdicts(judged)).toEqual({ [id.slice(0, 2)]: "fail", [other]: "pass" });
  });

  // One stage serves every trace of a run, so a moved stage fails them all.
  test("a stage edited after setup fails stage-hash on every trace", async () => {
    const judged = await check(evidence({ moved: (stage) => writeFileSync(join(stage, "plugins/pstack/README.md"), "edited after the drive\n") }));
    expect(failed(judged)).toEqual(["S2.context.stage-hash", "S3.startup.stage-hash"]);
    expect(said(judged, "S2.context.stage-hash")).toMatch(/^saw stage hash [0-9a-f]{64}, want the stage hash setup recorded, [0-9a-f]{64}$/);
  });

  test("a file mode changed in the stage moves the stage hash too", async () => {
    const judged = await check(evidence({ moved: (stage) => chmodSync(join(stage, MANDATE), 0o755) }));
    expect(failed(judged)).toEqual(["S2.context.stage-hash", "S3.startup.stage-hash"]);
  });

  test("a stage that is gone fails stage-hash and says so", async () => {
    const judged = await check(evidence({ moved: (stage) => rmSync(stage, { recursive: true }) }));
    expect(failed(judged)).toContain("S3.startup.stage-hash");
    expect(said(judged, "S3.startup.stage-hash")).toStartWith("saw the stage is gone, want the stage hash setup recorded");
  });
});

describe("traces a driver must not get past the checker", () => {
  test("a session that loaded the installed copy is the wrong tree", async () => {
    const installed = { name: "pstack", path: "/Users/someone/.claude/plugins/cache/pstack-claude/pstack/0.9.158", source: "pstack@pstack-claude", version: "0.9.158" };
    const judged = await check(evidence({ S2: { events: (events) => void Object.assign(pstack(events), installed) } }));
    expect(verdicts(judged)).toEqual({ S2: "fail", S3: "pass" });
    expect(failed(judged)).toEqual(["S2.context.plugin-path", "S2.context.plugin-source"]);
    expect(said(judged, "S2.context.plugin-path")).toStartWith(`saw plugin path ${installed.path}, want the stage's plugin directory, `);
  });

  test("a stream cut off before its result event fails, and the cut line is observed", async () => {
    const cut = (text) => text.slice(0, text.trimEnd().lastIndexOf("\n") + 40);
    const judged = await check(evidence({ S2: { raw: cut } }));
    expect(verdicts(judged)).toEqual({ S2: "fail", S3: "pass" });
    expect(failed(judged)).toEqual(["S2.context.result-present"]);
    expect(observed(judged)).toEqual(["S2 1 stream lines are not JSON"]);
  });

  test("the process exit code changes no verdict in either direction", async () => {
    const crashed = { exit_code: 1, signal: "SIGKILL", timed_out: true };
    expect(verdicts(await check(evidence({ S2: { sidecar: crashed }, S3: { sidecar: crashed } })))).toEqual({ S2: "pass", S3: "pass" });
    const clean = { exit_code: 0 };
    expect(verdicts(await check(evidence({ S3: { fixture: "hook-not-executable", sidecar: clean } })))).toEqual({ S2: "pass", S3: "fail" });
  });
});

describe("verdicts other than pass and fail", () => {
  test("a missing trace is unobservable and counts as failed", async () => {
    const judged = await check(evidence({ S3: { absent: true } }));
    expect(judged.line).toBe("FAIL surface 1/2 | behavior NOT BUILT | round 1");
    expect(judged.checks[1]).toMatchObject({ id: "S3", verdict: "unobservable", reason: "the startup trace is missing", failed: [] });
  });

  test("a trace without the hook response S3 judges is unobservable", async () => {
    const judged = await check(evidence({ S3: { events: (events) => events.filter((event) => !event.subtype?.startsWith("hook_")) } }));
    expect(judged.verdict).toBe("FAIL");
    expect(judged.checks[1]).toMatchObject({ verdict: "unobservable", reason: "a hook_response named SessionStart:startup is missing" });
  });

  test("a check that was not selected is skipped, and the count shows the run was partial", async () => {
    const judged = await check(evidence({ setup: { selection: { tier: "all", flow: "S2" }, selected: ["S2"] }, S3: { absent: true } }));
    expect(judged.line).toBe("PASS surface 1/2 | behavior NOT BUILT | round 1");
    expect(judged.checks[1]).toMatchObject({ id: "S3", verdict: "skipped", reason: "not selected" });
  });

  test("a run that selected nothing is SKIPPED, not PASS", async () => {
    const judged = await check(evidence({ setup: { selection: { tier: "behavior", flow: null }, selected: [] } }));
    expect(judged.line).toBe("SKIPPED surface NOT RUN | behavior NOT BUILT | round 1");
  });

  const cli = (fields) => ({ setup: { cli: { path: null, version: null, missing: true, required: false, problem: "claude is not on PATH", ...fields } }, S2: { absent: true }, S3: { absent: true } });

  test("no CLI skips every check and names the reason first", async () => {
    const judged = await check(evidence(cli({})));
    expect(judged.line).toBe("SKIPPED surface: claude is not on PATH | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ S2: "skipped", S3: "skipped" });
  });

  test("no CLI where one is required is an error", async () => {
    const judged = await check(evidence(cli({ required: true })));
    expect(judged.line).toBe("FAIL surface: claude is not on PATH | behavior NOT BUILT | round 1");
    expect(verdicts(judged)).toEqual({ S2: "error", S3: "error" });
  });

  test("a CLI older than the minimum is an error", async () => {
    const problem = "claude 2.1.245 is older than the minimum 2.1.332";
    const judged = await check(evidence(cli({ path: "claude", version: "2.1.245", missing: false, problem })));
    expect(judged.line).toBe(`FAIL surface: ${problem} | behavior NOT BUILT | round 1`);
    expect(verdicts(judged)).toEqual({ S2: "error", S3: "error" });
  });

  test("a check that throws is an error, and its tier is counted", async () => {
    const checks = tempDir();
    writeFileSync(join(checks, "B9-throws.mjs"), 'export const title = "throws";\nexport const tier = "behavior";\nexport function assertions() {\n  throw new TypeError("boom");\n}\n');
    const judged = await check(evidence({ setup: { selected: ["B9"] } }), checks);
    expect(judged.line).toBe("FAIL surface NOT BUILT | behavior 0/1 | round 1");
    expect(judged.checks[0].verdict).toBe("error");
    expect(judged.checks[0].reason).toStartWith("TypeError: boom");
  });
});

describe("observations", () => {
  const cases = [
    ["S2 2 SessionStart hook responses in one session", { S2: { events: (events) => [hook(events), ...events] } }],
    ["S2 hook SessionStart:startup wrote to stderr: warning: slow disk", { S2: { events: (events) => void (hook(events).stderr = "warning: slow disk\nsecond line\n") } }],
    ["S2 plugins beside pstack and the built-ins: other@market", { S2: { events: (events) => void init(events).plugins.push({ name: "other", path: "/opt/other", source: "other@market" }) } }],
    ["S2 MCP servers in init: github", { S2: { events: (events) => void (init(events).mcp_servers = [{ name: "github", status: "connected" }]) } }],
    ["S2 CLI 2.1.400; the checks were verified on 2.1.332", { S2: { events: (events) => void (init(events).claude_code_version = "2.1.400") } }],
    // The shape of the transcript's own record of the hook, read from a 2.1.332 session.
    ["S2 hook SessionStart:startup took 1500 ms", { S2: { transcript: `${JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "SessionStart:startup", exitCode: 0, durationMs: 1500 } })}\n` } }],
  ];

  test.each(cases)("%s, and the check still passes", async (text, edits) => {
    const judged = await check(evidence(edits));
    expect(observed(judged)).toEqual([text]);
    expect(verdicts(judged)).toEqual({ S2: "pass", S3: "pass" });
  });
});
