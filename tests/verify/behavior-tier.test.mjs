// What the model tier does around its checks, with no CLI and no model call:
// how it signs in, what it is allowed to cost, what its first line says when
// it did not run, and that the flows under it stay inside their caps. What
// each behavior check judges is in tests/verify/checks/B*.test.mjs.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../tools/verify/check.mjs";
import { BUDGET_USD, CHECKS_DIR, FLOWS_DIR, loadDir, MAX_MODEL_CALLS } from "../../tools/verify/paths.mjs";
import { behaviorAccess, caps, CREDENTIALS, plan } from "../../tools/verify/setup.mjs";
import { cleanup, evidence, shipped, tempDir } from "./harness.mjs";
import { lastResult } from "./doctor.mjs";

afterEach(cleanup);

const flows = await loadDir(FLOWS_DIR);
const checks = await loadDir(CHECKS_DIR);
const model = flows.filter((flow) => flow.tier === "behavior");
const NONE = { mode: "none", credential: [], required: false, planned: { max_usd: 0, max_turns: 0 } };
const FAKE = join(import.meta.dir, "fake-claude.mjs");
const session = (extra) => ({ id: "B0", tier: "behavior", name: "attempt-1", args: ["--max-turns", "1", "--max-budget-usd", "0.03"], ...extra });

describe("what the model tier may cost", () => {
  test("every flow of it sets a turn limit and a budget in its arguments, and the shipped ones add up to less than the limits", () => {
    expect(model.length).toBeGreaterThanOrEqual(5);
    const planned = caps(plan(model, tempDir()));
    expect(planned.max_usd).toBeLessThanOrEqual(BUDGET_USD);
    expect(planned.max_turns).toBeLessThanOrEqual(MAX_MODEL_CALLS);
    expect(planned).toEqual({ max_usd: 0.42, max_turns: 14 });
  });

  test.each([
    ["a turn limit", ["--max-budget-usd", "0.03"], "--max-turns"],
    ["a budget", ["--max-turns", "1"], "--max-budget-usd"],
    ["a budget of nothing", ["--max-turns", "1", "--max-budget-usd", "0"], "--max-budget-usd"],
    ["a budget that is not a number", ["--max-turns", "1", "--max-budget-usd", "lots"], "--max-budget-usd"],
  ])("a flow with no %s is refused", (_, args, flag) => {
    expect(() => caps([session({ args })])).toThrow(`B0/attempt-1 is a model-tier flow and must set ${flag} in its arguments`);
  });

  test("a plan that could cost more than the budget is refused before it starts", () => {
    const many = Array.from({ length: 6 }, (_, at) => session({ name: `attempt-${at}`, args: ["--max-turns", "1", "--max-budget-usd", "0.1"] }));
    expect(() => caps(many)).toThrow(`the model tier plans up to $0.6, over its budget of $${BUDGET_USD}`);
  });

  test("a plan with more turns than the limit is refused", () => {
    const turns = [session({ args: ["--max-turns", String(MAX_MODEL_CALLS + 1), "--max-budget-usd", "0.01"] })];
    expect(() => caps(turns)).toThrow(`the model tier plans up to ${MAX_MODEL_CALLS + 1} model turns, over its limit of ${MAX_MODEL_CALLS}`);
  });

  test("a surface flow is free of both", () => {
    expect(caps([{ id: "S0", tier: "surface", name: "x", args: [] }])).toEqual({ max_usd: 0, max_turns: 0 });
  });
});

describe("how the tier is signed in", () => {
  const box = { home: "/nowhere" };
  const cli = { path: FAKE, problem: null };

  test("a credential in the environment is a clean sign-in, by the names that are set", () => {
    expect(behaviorAccess(cli, box, { ANTHROPIC_API_KEY: "k", HOME: tempDir() })).toEqual({ mode: "clean", credential: ["ANTHROPIC_API_KEY"] });
    expect(behaviorAccess(cli, box, { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }).credential).toEqual(CREDENTIALS);
  });

  test("an empty credential is none, and with no login the tier does not run", () => {
    expect(behaviorAccess(cli, box, { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", HOME: tempDir() })).toEqual({ mode: "none", credential: [] });
  });

  test("a login that `claude auth status` finds is the local mode", () => {
    const home = tempDir();
    writeFileSync(join(home, ".stand-in-login"), "");
    expect(behaviorAccess(cli, box, { HOME: home, PATH: process.env.PATH })).toEqual({ mode: "local", credential: [] });
  });

  test("a CLI that cannot be driven, or no home, is none", () => {
    expect(behaviorAccess({ ...cli, problem: "claude is not on PATH" }, box, { HOME: tempDir() }).mode).toBe("none");
    expect(behaviorAccess(cli, box, {}).mode).toBe("none");
  });
});

describe("what a plan hands a session", () => {
  const env = { PATH: "/bin", TMPDIR: "/tmp", HOME: "/home/real", USER: "someone", CLAUDE_CONFIG_DIR: "/home/real/.claude", ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: "token", CLAUDECODE: "1" };
  const surface = { id: "S0", tier: "surface", runs: [{ name: "startup", args: [] }] };
  const behavior = { id: "B0", tier: "behavior", runs: [{ name: "attempt-1", args: ["--max-turns", "1", "--max-budget-usd", "0.03"], vars: { PSTACK_SESSION_HOOK: "off" } }, { name: "attempt-2", args: ["--max-turns", "1", "--max-budget-usd", "0.03"] }] };
  const names = (sessions) => sessions.map((each) => Object.keys(each.env).sort());

  test("a clean sign-in gives the model tier the credentials it names, and the surface tier nothing", () => {
    const sessions = plan([surface, behavior], tempDir(), env, { mode: "clean", credential: ["ANTHROPIC_API_KEY"] });
    expect(names(sessions)).toEqual([["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR"], ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "PATH", "PSTACK_SESSION_HOOK", "TMPDIR"], ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR"]]);
    // A throwaway home, not the person's.
    for (const each of sessions) expect(each.env.HOME).not.toBe("/home/real");
  });

  test("a local sign-in gives the model tier the person's home and login name, and no credential", () => {
    const sessions = plan([surface, behavior], tempDir(), env, { mode: "local", credential: [] });
    expect(names(sessions)).toEqual([["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR"], ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "PSTACK_SESSION_HOOK", "TMPDIR", "USER"], ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR", "USER"]]);
    expect(sessions[1].env).toMatchObject({ HOME: "/home/real", CLAUDE_CONFIG_DIR: "/home/real/.claude" });
    expect(sessions[0].env.HOME).not.toBe("/home/real");
    // The driver reads transcripts from a throwaway directory only.
    expect(sessions.map((each) => each.config === null)).toEqual([false, true, true]);
  });

  test("a local sign-in without a config directory of the person's names none", () => {
    const { CLAUDE_CONFIG_DIR, ...rest } = env;
    expect(names(plan([behavior], tempDir(), rest, { mode: "local", credential: [] }))[1]).toEqual(["HOME", "PATH", "TMPDIR", "USER"]);
  });

  test("with no way to sign in the model tier plans no session, and the surface tier still does", () => {
    expect(plan([surface, behavior], tempDir(), env, NONE).map((each) => each.id)).toEqual(["S0"]);
  });
});

describe("a flow's files", () => {
  const flow = (files) => ({ id: "B0", tier: "behavior", runs: [{ name: "attempt-1", args: ["--max-turns", "1", "--max-budget-usd", "0.03"], files }] });

  test("are the project its session starts in", async () => {
    const [made] = plan([flow({ "a.py": "x = 1\n", "pkg/b.py": "y = 2\n" })], tempDir(), {}, { mode: "clean", credential: [] });
    expect(await Bun.file(join(made.cwd, "a.py")).text()).toBe("x = 1\n");
    expect(await Bun.file(join(made.cwd, "pkg/b.py")).text()).toBe("y = 2\n");
  });

  test.each([["../escape.py"], ["/tmp/absolute.py"], ["a/../../up.py"]])("may not leave the working directory: %s", (name) => {
    expect(() => plan([flow({ [name]: "x" })], tempDir(), {}, { mode: "clean", credential: [] })).toThrow("a flow file may not leave its working directory");
  });
});

describe("what the first line says", () => {
  const all = { checks: CHECKS_DIR, runs: [], behavior: true };
  const selected = ["B1", "B2", "B3", "B4", "B5"];

  test("with no credential the tier is not run, the word is PARTIAL, and nothing passed in it", async () => {
    const judged = await check(evidence(all, { setup: { behavior: NONE, selected } }));
    expect(judged.line).toBe("PARTIAL surface NOT RUN | behavior NOT RUN: no credential | round 1");
    expect(judged.verdict).toBe("PARTIAL");
    expect(judged.checks.filter((each) => each.tier === "behavior").map((each) => [each.verdict, each.reason])).toEqual(selected.map(() => ["skipped", "no credential"]));
  });

  test("--require-behavior turns that into a failure, on every behavior check", async () => {
    const judged = await check(evidence(all, { setup: { behavior: { ...NONE, required: true }, selected } }));
    expect(judged.verdict).toBe("FAIL");
    expect(judged.line).toStartWith("FAIL surface NOT RUN | behavior NOT RUN: no credential |");
    expect(judged.checks.filter((each) => each.verdict === "error").length).toBe(selected.length);
  });

  test("a tier that was not asked for is NOT RUN with no reason, and never the word PASS", async () => {
    const judged = await check(evidence(all, { setup: { behavior: null, selected: [] } }));
    expect(judged.line).toBe("PARTIAL surface NOT RUN | behavior NOT RUN | round 1".replace("PARTIAL", judged.verdict));
    expect(judged.verdict).not.toBe("PASS");
  });

  test("a run that called a model says its calls and its cost, and the cost is in the evidence", async () => {
    const B1 = await shipped("B1");
    const judged = await check(evidence(B1));
    expect(judged.line).toMatch(/^PARTIAL surface NOT RUN \| behavior 1\/5 \(3 model calls, \$0\.\d{4}\) \| round 1$/);
    expect(judged.model_calls).toBe(3);
    expect(judged.cost_usd).toBeGreaterThan(0);
    expect(judged.cost_usd).toBeLessThan(BUDGET_USD);
  });

  // The words of the first line, over every shipped check at once.
  test("with every check run and every one passing, the word is PASS and the line holds both tiers", async () => {
    const parts = await Promise.all(["S2", "S3", "B1", "B2", "B3", "B4", "B5"].map(shipped));
    const judged = await check(evidence({ checks: CHECKS_DIR, skills: true, behavior: true, runs: parts.flatMap((part) => part.runs) }));
    expect(judged.line).toMatch(/^PASS surface 2\/2 \| behavior 5\/5 \(\d+ model calls, \$0\.\d{4}\) \| round 1$/);
  });

  test("a run that cost more than its budget fails whatever its checks found", async () => {
    const B1 = await shipped("B1");
    const judged = await check(evidence(B1, { "B1.attempt-1": { events: (events) => void (lastResult(events).total_cost_usd = BUDGET_USD + 0.1) } }));
    expect(judged.verdict).toBe("FAIL");
    expect(judged.line).toContain(`over the $${BUDGET_USD} budget`);
  });
});

describe("the flows and their checks", () => {
  test("every behavior check states its pass rule, and its flow samples as many attempts as the rule counts", () => {
    for (const each of checks.filter((entry) => entry.tier === "behavior")) {
      const flow = flows.find((entry) => entry.id === each.id);
      expect(each.rule.needs).toBeGreaterThanOrEqual(1);
      expect(each.rule.needs).toBeLessThanOrEqual(each.rule.attempts);
      expect(flow.runs.length).toBe(each.rule.attempts);
      expect(Object.keys(each.args).length).toBe(each.rule.attempts);
    }
  });

  test("every behavior flow runs under the same limits and with the person's settings and MCP servers left out", () => {
    for (const flow of model) {
      for (const run of flow.runs) {
        for (const flag of ["--max-turns", "--max-budget-usd", "--setting-sources", "--strict-mcp-config", "--no-session-persistence"]) expect(run.args).toContain(flag);
        expect(run.args[run.args.indexOf("--setting-sources") + 1]).toBe("");
        expect(run.args).not.toContain("--bare");
        expect(run.timeoutMs).toBeGreaterThan(0);
      }
    }
  });

  // B5 means something only as B1 with one condition changed.
  test("B5 is B1's prompt, project and limits with the hook off, and nothing else", () => {
    const [b1, b5] = ["B1", "B5"].map((id) => flows.find((flow) => flow.id === id));
    const same = (run) => JSON.stringify([run.args, run.files, run.timeoutMs]);
    expect(b5.runs.map(same)).toEqual(b1.runs.map(same));
    expect(b1.runs.some((run) => run.vars)).toBe(false);
    expect(b5.runs.map((run) => run.vars)).toEqual(b5.runs.map(() => ({ PSTACK_SESSION_HOOK: "off" })));
    const [c1, c5] = ["B1", "B5"].map((id) => checks.find((entry) => entry.id === id));
    expect(c5.args).toEqual(c1.args);
  });
});
