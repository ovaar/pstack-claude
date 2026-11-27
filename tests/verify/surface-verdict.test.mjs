// The surface job passes only when the verifier's first line starts with
// PASS. The verifier exits 0 for SKIPPED, PARTIAL and STAND-IN, so the step
// that runs it has to turn each of them into a failure. This runs that step
// under `bash -e` with a stub bun that prints a chosen first line.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/behavior.yml", import.meta.url), "utf8"));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const step = steps.find((each) => each.run?.includes("tools/verify.mjs"));

function run(line, exit) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-surface-verdict-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "step.sh"), step.run);
    writeFileSync(join(dir, "bin/bun"), `#!/bin/bash\necho "$VERDICT"\necho "- run: 1"\nexit ${exit}\n`, { mode: 0o755 });
    const { status, stdout } = spawnSync("bash", ["-e", "step.sh"], {
      cwd: dir,
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, RUNNER_TEMP: dir, VERDICT: line },
      encoding: "utf8",
    });
    return { passed: status === 0, stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the surface job's verdict", () => {
  const job = Object.values(workflow.jobs)[0];

  test("cannot be turned green around the verdict: no continue-on-error, no condition, no needs", () => {
    expect(Object.keys(workflow.jobs)).toHaveLength(1);
    expect(job.steps).toBeDefined();
    for (const key of ["continue-on-error", "if", "needs", "uses"]) expect(job).not.toHaveProperty(key);
    expect(step).not.toHaveProperty("continue-on-error");
    expect(step).not.toHaveProperty("if");
    expect(step).not.toHaveProperty("shell");
    expect(step.run).not.toMatch(/\|\|\s*true/);
    expect(workflow.defaults?.run).toBeUndefined();
  });

  test("evidence upload keeps the hidden files of the stage", () => {
    const upload = job.steps.find((each) => each.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.with["include-hidden-files"]).toBe(true);
  });

  test("passes on a PASS line", () => {
    expect(run("PASS surface 2/2 | behavior NOT BUILT | round 1", 0).passed).toBe(true);
  });

  test.each(["PARTIAL surface 2/2 | behavior NOT RUN | round 1", "PARTIAL surface 1/1 | behavior NOT BUILT | round 3"])("passes on %p: every surface check passed and the other tier was only left out", (line) => {
    expect(run(line, 0).passed).toBe(true);
  });

  test.each([
    "PARTIAL surface 1/2 | behavior NOT RUN | round 1",
    "PARTIAL surface 0/0 | behavior NOT RUN | round 1",
    "PARTIAL surface 2/2 | behavior 0/5 | round 1",
    "PARTIAL surface 2/2 | behavior 3/5 | round 1",
    "PARTIAL surface NOT RUN | behavior NOT RUN | round 1",
    "PARTIAL surface: claude is too old | behavior NOT RUN | round 1",
    "PARTIAL behavior 2/2 | surface NOT RUN | round 1",
    "PARTIAL surface 2/2 | behavior NOT RUN",
    "PARTIAL surface 2/2 | behavior NOT RUN | extra | round 1",
  ])("fails on %p", (line) => {
    expect(run(line, 0).passed).toBe(false);
  });

  test.each(["SKIPPED surface: claude is not on PATH", "PARTIAL surface 2/2 | behavior 0/5", "STAND-IN surface 2/2", "FAIL surface 1/2", "", "pass surface 2/2", "PASSED"])("fails on %p", (line) => {
    expect(run(line, 0).passed).toBe(false);
  });

  test("fails on a nonzero exit even after a PASS line, and prints the verdict", () => {
    const result = run("PASS surface 2/2", 1);
    expect(result.passed).toBe(false);
    expect(result.stdout).toContain("PASS surface 2/2");
  });

  test("asks the verifier for the surface tier only, with a CLI that must exist and evidence outside the checkout", () => {
    expect(step.run).toContain('--tier surface --evidence "$RUNNER_TEMP/verify"');
    expect(step.env).toEqual({ PSTACK_VERIFY_REQUIRE_CLI: "1" });
  });

  test("needs no secret, makes no model call, and never runs on pull_request_target", () => {
    const text = readFileSync(new URL("../../.github/workflows/behavior.yml", import.meta.url), "utf8");
    expect(text).not.toMatch(/\bsecrets\./);
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|PSTACK_VERIFY_CLAUDE/);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });
});
