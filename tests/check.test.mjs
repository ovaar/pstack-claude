import { expect, test } from "bun:test";

import { exitCode, runSteps, summary } from "../tools/check.mjs";

const quiet = { log: () => {} };
const exitWith = (failing = []) => (step) => ({ status: failing.includes(step.name) ? 1 : 0 });

test("a failing step fails the run and the others still run", () => {
  const list = [{ name: "a", argv: ["a"] }, { name: "b", argv: ["b"] }, { name: "c", argv: ["c"] }];
  const results = runSteps(list, { ...quiet, exec: exitWith(["b"]) });
  expect(results.map((r) => r.status)).toEqual(["passed", "failed", "passed"]);
  expect(exitCode(results)).toBe(1);
});

test("a missing binary is skipped with its reason, never passed, and does not fail the run", () => {
  const ran = [];
  const results = runSteps([{ name: "lint", needs: "lint", argv: ["lint"] }], {
    ...quiet,
    which: () => null,
    exec: (step) => ran.push(step.name),
  });
  expect(results).toEqual([{ name: "lint", status: "skipped", reason: "lint is not on PATH" }]);
  expect(ran).toEqual([]);
  expect(exitCode(results)).toBe(0);
});

test("a step that cannot start counts as failed", () => {
  const results = runSteps([{ name: "a", argv: ["a"] }], { ...quiet, exec: () => ({ status: null, error: new Error("ENOENT") }) });
  expect(results[0].status).toBe("failed");
});

test("the last line lists passed, failed and skipped", () => {
  expect(
    summary([
      { name: "a", status: "passed" },
      { name: "b", status: "failed" },
      { name: "c", status: "skipped", reason: "c is not on PATH" },
    ]),
  ).toBe("passed 1 [a] | failed 1 [b] | skipped 1 [c (c is not on PATH)]");
});
