// The honesty job and the model-tier jobs of .github/workflows/behavior.yml.
// The fork holds no secret, so the model tier's skip path is the one CI takes
// today: each step body here runs under bash with no credential and with a
// dummy one, against a stub bun, and what it prints, writes to the summary
// and hands the next steps is read back. No step may print the credential.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runStep, stepNamed, TEXT, workflow } from "./workflow.mjs";

const DUMMY = "sk-ant-oat01-dummy-for-the-skip-path-test-0000";
const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const jobs = workflow.jobs;
const allSteps = Object.values(jobs).flatMap((job) => job.steps);
const PRESENT = "${{ steps.credential.outputs.present == 'true' }}";
const SECRET_STEPS = ["Look for a credential", "Verify the plugin with a model in the loop", "Make sure the evidence holds no credential"];
const leaks = (result) => [result.stdout, result.stderr, result.output, result.summary].filter((text) => text.includes(DUMMY));

describe("the workflow as a whole", () => {
  test("has the four jobs, and no job or step can be turned green with continue-on-error", () => {
    expect(Object.keys(jobs)).toEqual(["surface", "honesty", "behavior", "behavior-fork"]);
    expect(jobs.honesty.name).toBe("Verifier honesty (no model calls)");
    expect(jobs.behavior.name).toBe("Claude Code behavior (haiku)");
    expect(TEXT).not.toContain("continue-on-error");
    expect(TEXT).not.toMatch(/\|\|\s*true\b/);
  });

  test("runs on every pull request, on main, nightly and by hand, and never on pull_request_target", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
    expect(workflow.on.pull_request).toBeNull();
    expect(workflow.on.schedule).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
    expect(TEXT).not.toContain("pull_request_target");
  });

  // A secret reaches three steps of the behavior job by name, and nothing
  // else: no workflow or job environment, no other job, no `with`.
  test("hands a secret to the three steps of the behavior job that need it, and to nothing else", () => {
    const holders = Object.entries(jobs).flatMap(([id, job]) => job.steps.filter((step) => JSON.stringify(step).includes("secrets.")).map((step) => `${id}: ${step.name}`));
    expect(holders).toEqual(SECRET_STEPS.map((name) => `behavior: ${name}`));
    expect(workflow.env).toBeUndefined();
    for (const job of Object.values(jobs)) expect(job.env).toBeUndefined();
    for (const name of SECRET_STEPS) {
      expect(stepNamed("behavior", name).env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}", ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    }
    expect(TEXT.match(/secrets\.[A-Z_]+/g).every((each) => ["secrets.CLAUDE_CODE_OAUTH_TOKEN", "secrets.ANTHROPIC_API_KEY"].includes(each))).toBe(true);
  });
});

describe("the honesty job", () => {
  const job = jobs.honesty;

  test("plants every known mistake against the real CLI, holds them to the base, and shows the table whatever happened", () => {
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"]).toBe(0);
    expect(job.steps.some((step) => step.run?.includes("npm install -g"))).toBe(true);
    expect(stepNamed("honesty", "Plant known mistakes and check each is caught").run).toContain('bun tools/verify.mjs honesty --out "$RUNNER_TEMP/honesty.md"');
    const summary = stepNamed("honesty", "Show the honesty table in the job summary");
    expect(summary.if).toBe("${{ always() }}");
    expect(summary.run).toContain("$RUNNER_TEMP/honesty.md");
  });

  const ratchet = stepNamed("honesty", "Hold the planted mistakes to the base");

  test("a pull request is held to the merge base with its base branch, and the ratchet's verdict is the step's", () => {
    const ok = runStep(ratchet, { env: { EVENT: "pull_request", BASE_REF: "main" }, verdict: "ratchet: OK against origin/main" });
    expect(ok.passed).toBe(true);
    expect(ok.calls).toEqual(["tools/verify.mjs honesty --base origin/main"]);
    const raised = runStep(ratchet, { env: { EVENT: "pull_request", BASE_REF: "main" }, verdict: "ratchet: FAIL", exit: 1 });
    expect(raised.passed).toBe(false);
    expect(raised.stdout).toContain("ratchet: FAIL");
  });

  test("a push is held to the commit it replaced, and a nightly run says it compared nothing", () => {
    expect(runStep(ratchet, { env: { EVENT: "push", BEFORE: "a".repeat(40) }, verdict: "ratchet: OK" }).calls).toEqual([`tools/verify.mjs honesty --base ${"a".repeat(40)}`]);
    const nightly = runStep(ratchet, { env: { EVENT: "schedule" } });
    expect(nightly.passed).toBe(true);
    expect(nightly.calls).toEqual([]);
    expect(nightly.stdout).toBe("ratchet: NOT RUN, a schedule run has no base to compare with\n");
  });
});

describe("the behavior job", () => {
  const job = jobs.behavior;
  const look = stepNamed("behavior", "Look for a credential");
  const verify = stepNamed("behavior", "Verify the plugin with a model in the loop");
  const clean = stepNamed("behavior", "Make sure the evidence holds no credential");

  test("takes its secrets from the claude-behavior environment, and never runs for a pull request from a fork", () => {
    expect(job.environment).toBe("claude-behavior");
    expect(job.if).toBe("${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}");
    expect(jobs["behavior-fork"].if).toBe("${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}");
    expect(job.needs).toBeUndefined();
  });

  test("runs nothing after the credential check unless a credential is there", () => {
    const after = job.steps.slice(job.steps.indexOf(look) + 1);
    expect(after.filter((step) => !String(step.if ?? "").includes("steps.credential.outputs.present == 'true'") && !String(step.if ?? "").includes("steps.clean.outputs.clean == 'true'"))).toEqual([]);
    expect(after.filter((step) => step.if === PRESENT).map((step) => step.name ?? step.uses.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun", "Install dependencies", "Install the Claude Code CLI at the pinned version", "Verify the plugin with a model in the loop"]);
  });

  describe("with no credential", () => {
    const result = runStep(look, { env: {} });

    test("passes, and says it skipped in a notice and in the job summary", () => {
      expect(result.passed).toBe(true);
      expect(result.output).toBe("present=false\n");
      expect(result.stdout).toContain("::notice title=Behavior checks SKIPPED::no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the claude-behavior environment, so B1 to B5 did not run");
      expect(result.summary).toBe("behavior tier: SKIPPED, no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the claude-behavior environment. B1 to B5 did not run; this is not a pass.\n");
    });

    test("an empty secret is no credential", () => {
      expect(runStep(look, { env: { CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "" } }).output).toBe("present=false\n");
    });
  });

  describe.each(CREDENTIALS)("with a dummy %s", (name) => {
    test("the credential check says present, writes no summary, and never prints the value", () => {
      const result = runStep(look, { env: { [name]: DUMMY } });
      expect(result.passed).toBe(true);
      expect(result.output).toBe("present=true\n");
      expect(result.summary).toBe("");
      expect(result.stdout).not.toContain("SKIPPED");
      expect(leaks(result)).toEqual([]);
    });

    test("the run asks for every tier with the model tier required, and passes only on PASS with every tier n/n", () => {
      const pass = runStep(verify, { env: { [name]: DUMMY }, verdict: "PASS surface 7/7 | behavior 5/5 (15 model calls, $0.0461) | round 1" });
      expect(pass.passed).toBe(true);
      expect(pass.calls[0]).toStartWith("tools/verify.mjs --tier all --require-behavior --evidence ");
      expect(pass.calls[1]).toBe("tools/verify/verdict.mjs all");
      expect(leaks(pass)).toEqual([]);
      for (const line of ["PARTIAL surface 7/7 | behavior NOT RUN: no credential | round 1", "PARTIAL surface 7/7 | behavior NOT RUN | round 1", "PASS surface 7/7 | behavior NOT BUILT | round 1", "STAND-IN surface 7/7 | behavior 5/5 (15 model calls, $0.0461) | round 1"]) {
        const result = runStep(verify, { env: { [name]: DUMMY }, verdict: line });
        expect(result.passed).toBe(false);
        expect(result.stdout).toContain(`::error title=Behavior checks not PASS::${line}`);
      }
    });

    test("a refused credential, which the verifier fails, fails the job", () => {
      const refused = runStep(verify, { env: { [name]: DUMMY }, verdict: "FAIL surface 7/7 | behavior 0/5 (0 model calls, $0.0000) | round 1", exit: 1 });
      expect(refused.passed).toBe(false);
      expect(refused.calls).toHaveLength(1);
    });

    // The evidence is searched for the value itself before it may leave.
    test("evidence that holds the value is deleted and fails the job, without printing it", () => {
      const put = (text) => (dir) => {
        mkdirSync(join(dir, "verify/runs/r/traces/B1"), { recursive: true });
        writeFileSync(join(dir, "verify/runs/r/traces/B1/attempt-1.jsonl"), text);
      };
      const dirty = runStep(clean, { env: { [name]: DUMMY }, before: put(`{"type":"system","token":"${DUMMY}"}\n`), after: (dir) => existsSync(join(dir, "verify")) });
      expect(dirty.passed).toBe(false);
      expect(dirty.after).toBe(false);
      expect(dirty.stdout).toContain(`::error title=Evidence held a credential::the evidence held the value of ${name}, so it was deleted and not uploaded`);
      expect(dirty.output).toBe("");
      expect(leaks(dirty)).toEqual([]);

      const tidy = runStep(clean, { env: { [name]: DUMMY }, before: put('{"type":"system","apiKeySource":"none"}\n'), after: (dir) => existsSync(join(dir, "verify")) });
      expect(tidy.passed).toBe(true);
      expect(tidy.after).toBe(true);
      expect(tidy.output).toBe("clean=true\n");
    });
  });

  test("uploads the evidence, hidden files included, only once it was searched", () => {
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("${{ !cancelled() && steps.clean.outputs.clean == 'true' }}");
    expect(upload.with).toMatchObject({ name: "claude-behavior-evidence", path: "${{ runner.temp }}/verify", "include-hidden-files": true });
    expect(job.steps.indexOf(upload)).toBeGreaterThan(job.steps.indexOf(clean));
  });
});

describe("a pull request from a fork", () => {
  const job = jobs["behavior-fork"];

  test("gets no secret, and says visibly that the model tier did not run", () => {
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.environment).toBeUndefined();
    const result = runStep(job.steps[0]);
    expect(result.passed).toBe(true);
    expect(result.stdout).toContain("::notice title=Behavior checks SKIPPED::a pull request from a fork gets no credential, so B1 to B5 did not run");
    expect(result.summary).toContain("behavior tier: SKIPPED, a pull request from a fork gets no credential");
  });
});

test("every step that runs a shell is plain bash: none overrides the shell", () => {
  expect(allSteps.filter((step) => step.shell)).toEqual([]);
});
