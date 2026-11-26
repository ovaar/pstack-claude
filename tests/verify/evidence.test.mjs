// What a run writes for people and for a later gate: the verdict line first,
// one row per check, a receipt that lists every check, nothing private.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../tools/verify/check.mjs";
import { markdown, nextRound, prune, receipt, recordRound, redact, writeEvidence } from "../../tools/verify/evidence.mjs";
import { cleanup, evidence, tempDir } from "./harness.mjs";

afterEach(cleanup);

const MANDATE_SHA256 = "39dc6bebcc7b50e6add4b28d470b2faf9f34391fad1bf847039bbe76f26e84e4";
// Built at run time so that no scanner reads these lines as a leak.
const token = ["sk", "ant", "api03", "x".repeat(24)].join("-");
const address = ["someone", "example.com"].join("@");

test("evidence.md opens with the verdict line and quotes the hook's exit code and stdout digest", async () => {
  const lines = markdown(await check(evidence())).split("\n");
  expect(lines[0]).toBe("PASS surface 2/2 | behavior NOT BUILT | round 1");
  expect(lines.find((line) => line.startsWith("| S3 "))).toBe(
    `| S3 the mandate arrives at startup | pass | 1 hook_response named SessionStart:startup; exit_code 0; outcome success; stdout sha256 ${MANDATE_SHA256} (983 bytes); empty stderr; 11 of 11 integrity rules hold |`,
  );
  expect(lines.find((line) => line.startsWith("| S2 "))).toBe("| S2 the plugin loads from the tree | pass | no plugin_errors; 11 of 11 integrity rules hold |");
  expect(lines.slice(lines.indexOf("## Observations"))).toEqual(["## Observations", "", "None.", ""]);
});

test("a failed row names each failed assertion with what was seen and wanted", async () => {
  const text = markdown(await check(evidence({ S3: { fixture: "hook-not-executable" } })));
  const row = text.split("\n").find((line) => line.startsWith("| S3 "));
  expect(row).toStartWith("| S3 the mandate arrives at startup | fail | exit-code: saw exit_code 126, want exit_code 0; outcome: saw outcome error, want outcome success; ");
  expect(text).toContain("- S3 startup: hook SessionStart:startup wrote to stderr: /bin/sh: ");
});

test("the receipt lists every check with its own verdict, so a partial run cannot pass for a full one", async () => {
  const partial = receipt(await check(evidence({ setup: { selection: { tier: "all", flow: "S2" }, selected: ["S2"] } })));
  expect(partial).toMatchObject({ subject_id: "fixture", verdict: "PASS", line: "PASS surface 1/2 | behavior NOT BUILT | round 1", selection: { tier: "all", flow: "S2" }, cli_version: "2.1.332", cost_usd: 0 });
  expect(partial.checks).toEqual([
    { id: "S2", tier: "surface", verdict: "pass" },
    { id: "S3", tier: "surface", verdict: "skipped", reason: "not selected" },
  ]);

  const failing = receipt(await check(evidence({ S3: { fixture: "hook-not-executable" } })));
  expect(failing.verdict).toBe("FAIL");
  expect(failing.checks[1]).toEqual({ id: "S3", tier: "surface", verdict: "fail", failed: ["S3.exit-code", "S3.outcome", "S3.stdout", "S3.stderr"] });
});

test("redact removes home paths, email addresses and token-shaped strings, and keeps digests and plugin sources", () => {
  expect(redact("/Users/someone/work and /home/runner/work and C:\\Users\\someone\\work")).toBe("~/work and ~/work and ~\\work");
  expect(redact("in /srv/people/ada/checkout", "/srv/people/ada")).toBe("in ~/checkout");
  expect(redact(`mail ${address} now`)).toBe("mail <email> now");
  expect(redact(`key ${token}.`)).toBe("key <token>.");
  const kept = `stdout sha256 ${MANDATE_SHA256} from pstack@inline and cc-plugin-privacy@builtin`;
  expect(redact(kept)).toBe(kept);
});

test("the three written files are redacted", async () => {
  const stderr = `cat: /Users/someone/stage/x: No such file, ask ${address}\n`;
  const dir = evidence({ S3: { events: (events) => void (events.find((event) => event.subtype === "hook_response").stderr = stderr) } });
  writeEvidence(dir, await check(dir));
  for (const file of ["evidence.md", "evidence.json", "receipt.json"]) {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text).not.toContain("/Users/someone");
    expect(text).not.toContain(address);
  }
  expect(readFileSync(join(dir, "evidence.md"), "utf8")).toContain("cat: ~/stage/x: No such file, ask <email>");
  expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).checks[1].failed).toEqual(["S3.stderr"]);
});

test("a round counts the failed runs since the last pass", () => {
  const root = tempDir();
  const ended = (verdict, failed = []) => ({ verdict, run: "r", subject_id: "s", checks: [{ failed }] });
  expect(nextRound(root)).toBe(1);
  recordRound(root, ended("FAIL", ["S3.exit-code"]));
  recordRound(root, ended("SKIPPED"));
  expect(nextRound(root)).toBe(2);
  recordRound(root, ended("FAIL", ["S3.exit-code"]));
  expect(nextRound(root)).toBe(3);
  expect(JSON.parse(readFileSync(join(root, "rounds.json"), "utf8"))).toEqual([
    { run: "r", subject_id: "s", failed: ["S3.exit-code"] },
    { run: "r", subject_id: "s", failed: ["S3.exit-code"] },
  ]);
  recordRound(root, ended("PASS"));
  expect(nextRound(root)).toBe(1);
});

test("the last five runs are kept, each with its stage, and older ones are dropped", () => {
  const root = tempDir();
  const sandboxes = tempDir();
  const runs = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `20261126T10000${name}`);
  for (const run of runs) {
    mkdirSync(join(root, "runs", run), { recursive: true });
    mkdirSync(join(sandboxes, run, "stage"), { recursive: true });
  }
  prune(root, sandboxes);
  expect(readdirSync(join(root, "runs")).sort()).toEqual(runs.slice(2));
  expect(readdirSync(sandboxes).sort()).toEqual(runs.slice(2));
  expect(existsSync(join(sandboxes, runs[6], "stage"))).toBe(true);
});
