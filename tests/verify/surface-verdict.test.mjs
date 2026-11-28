// The surface job passes only on a verdict the push gate would accept too.
// The verifier exits 0 for SKIPPED, PARTIAL and STAND-IN, so the step that
// runs it has to turn each of them into a failure, through the same reader
// the gate uses. This runs that step under bash with a stub bun that prints a
// chosen first line for tools/verify.mjs and runs the real reader.
import { describe, expect, test } from "bun:test";

import { judgeLine } from "../../tools/verify/verdict.mjs";
import { judgeLine as gateLine } from "../../tools/verify/gate.mjs";
import { runStep, stepNamed, TEXT, workflow } from "./workflow.mjs";

const job = workflow.jobs.surface;
const step = stepNamed("surface", "Verify the plugin loads and starts in Claude Code");
const run = (line, exit = 0) => runStep(step, { verdict: line, exit });

// What a surface run can print. The first is the real line on this tree:
// seven surface checks, and a behavior tier --tier surface leaves out.
const ACCEPTED = [
  "PARTIAL surface 7/7 | behavior NOT RUN | round 1",
  "PASS surface 2/2 | behavior NOT BUILT | round 1",
  "PARTIAL surface 1/1 | behavior NOT BUILT | round 3",
  "PARTIAL surface 7/7 | behavior NOT RUN: no credential | round 2",
];
const REFUSED = [
  "PARTIAL surface 1/2 | behavior NOT RUN | round 1",
  "PARTIAL surface 0/0 | behavior NOT RUN | round 1",
  "PARTIAL surface 2/2 | behavior 0/5 (0 model calls, $0.0000) | round 1",
  "PARTIAL surface 2/2 | behavior 3/5 (9 model calls, $0.0300) | round 1",
  "PARTIAL surface NOT RUN | behavior NOT RUN | round 1",
  "PARTIAL surface: claude is too old | behavior NOT RUN | round 1",
  "PARTIAL surface 7/7 | behavior: claude is too old | round 1",
  "PARTIAL behavior 2/2 | surface NOT RUN | round 1",
  "PARTIAL surface 2/2 | behavior NOT RUN",
  "PARTIAL surface 2/2 | behavior NOT RUN | extra | round 1",
  "PASS surface 2/2 | extra | round 1",
  "SKIPPED surface: claude is not on PATH | behavior NOT RUN | round 1",
  "STAND-IN surface 2/2 | behavior NOT RUN | round 1",
  "FAIL surface 1/2 | behavior NOT RUN | round 1",
  "RECHECK PASS surface 2/2 | behavior NOT BUILT | round 1",
  "",
  "pass surface 2/2 | round 1",
  "PASSED",
];

describe("the surface job's verdict", () => {
  test("cannot be turned green around the verdict: no continue-on-error, no condition, no needs", () => {
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

  test.each(ACCEPTED)("passes on %p: every surface check passed and the other tier was only left out", (line) => {
    expect(run(line).passed).toBe(true);
  });

  test.each(REFUSED)("fails on %p", (line) => {
    const result = run(line);
    expect(result.passed).toBe(false);
    if (line) expect(result.stdout).toContain(`::error title=Surface checks not PASS::${line}`);
  });

  // One reader: the step, the gate and verdict.mjs agree on every line.
  test.each([...ACCEPTED, ...REFUSED])("the gate reads %p as the job does", (line) => {
    expect(gateLine(line).ok).toBe(judgeLine(line, "surface").ok);
    expect(judgeLine(line, "surface").ok).toBe(ACCEPTED.includes(line));
  });

  test("hands the first line to tools/verify/verdict.mjs, and to nothing else", () => {
    const result = run(ACCEPTED[0]);
    expect(result.calls).toEqual([`tools/verify.mjs --tier surface --evidence ${result.calls[0].split("--evidence ")[1]}`, "tools/verify/verdict.mjs surface"]);
  });

  test("fails on a nonzero exit even after a PASS line, and prints the verdict", () => {
    const result = run("PASS surface 2/2 | behavior NOT BUILT | round 1", 1);
    expect(result.passed).toBe(false);
    expect(result.stdout).toContain("PASS surface 2/2");
  });

  test("asks the verifier for the surface tier only, with a CLI that must exist and evidence outside the checkout", () => {
    expect(step.run).toContain('--tier surface --evidence "$RUNNER_TEMP/verify"');
    expect(step.env).toEqual({ PSTACK_VERIFY_REQUIRE_CLI: "1" });
  });

  test("needs no secret, and the workflow never runs on pull_request_target", () => {
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|PSTACK_VERIFY_CLAUDE/);
    expect(TEXT).not.toContain("pull_request_target");
    expect(workflow.permissions).toEqual({ contents: "read" });
  });
});
