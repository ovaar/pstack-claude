// The whole command, offline. A stand-in for the CLI replays the recorded
// traces, so setup, the driver, the checker and the evidence writer run as
// one, against a small repository whose product paths match the recordings.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { cleanup, git, productRepo, tempDir } from "./harness.mjs";

// Stages are kept after a run, so each test gets a temp directory that goes
// away with it.
let tmp;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(cleanup);

const VERIFY = join(import.meta.dir, "../../tools/verify.mjs");
const FAKE_CLI = join(import.meta.dir, "fake-claude.mjs");
// The stand-in's shebang needs bun, and "no CLI" needs a PATH without claude.
const PATH = [dirname(process.execPath), ...process.env.PATH.split(delimiter).filter((dir) => !existsSync(join(dir, "claude")))].join(delimiter);
const SESSION_VARIABLES = ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR", ...("LANG" in process.env ? ["LANG"] : [])].sort();
const HOSTILE = { PSTACK_SESSION_HOOK: "off", PLUGIN_ROOT: "/x", MINIMAX_PLUGIN_ROOT: "/x", ANTHROPIC_API_KEY: "dummy", CLAUDE_CODE_OAUTH_TOKEN: "dummy", CLAUDECODE: "1" };

function verify(args, env = {}) {
  const result = spawnSync(process.execPath, [VERIFY, ...args], { encoding: "utf8", env: { ...process.env, PATH, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, ...env } });
  return { status: result.status, lines: result.stdout.split("\n"), stdout: result.stdout, stderr: result.stderr };
}

const runsOf = (root) => readdirSync(join(root, "runs")).sort().map((run) => join(root, "runs", run));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const LONG = 60_000;

test.skipIf(process.platform === "win32")("a full run passes, hands a session only the allow-listed variables, and leaves the tree clean", () => {
  const repo = productRepo();
  const root = tempDir();
  const run = verify(["--tier", "surface", "--tree", repo, "--evidence", root], HOSTILE);
  expect(run.lines[0]).toBe("PASS surface 2/2 | behavior NOT BUILT | round 1");
  expect(run.status).toBe(0);

  const [dir] = runsOf(root);
  expect(run.lines.at(-2)).toBe(`evidence: ${dir}`);
  expect(readFileSync(join(dir, "evidence.md"), "utf8").split("\n")[0]).toBe(run.lines[0]);
  expect(json(join(dir, "receipt.json"))).toMatchObject({
    verdict: "PASS",
    selection: { tier: "surface", flow: null },
    checks: [
      { id: "S2", tier: "surface", verdict: "pass" },
      { id: "S3", tier: "surface", verdict: "pass" },
    ],
    cli_version: "2.1.332",
    cost_usd: 0,
  });
  for (const trace of ["S2/context", "S3/startup"]) {
    expect(readFileSync(join(dir, "traces", `${trace}.stderr`), "utf8")).toBe(`${SESSION_VARIABLES.join(" ")}\n`);
    expect(json(join(dir, "traces", `${trace}.sidecar.json`))).toMatchObject({ env: SESSION_VARIABLES, exit_code: 0, timed_out: false });
  }
  expect(json(join(dir, "traces/S3/startup.sidecar.json")).argv.slice(-2)).toEqual(["--input-format", "stream-json"]);

  const { stage } = json(join(dir, "setup.json"));
  expect(readdirSync(dirname(stage))).toEqual(["stage"]);
  expect(git(repo, "status", "--porcelain")).toBe("");
}, LONG);

test.skipIf(process.platform === "win32")("the checker rerun alone passes on the same evidence and fails once the stage is edited", () => {
  const root = tempDir();
  verify(["--tree", productRepo(), "--evidence", root]);
  const [dir] = runsOf(root);
  const rerun = verify(["check", dir]);
  expect([rerun.status, rerun.lines[0]]).toEqual([0, "PASS surface 2/2 | behavior NOT BUILT | round 1"]);

  writeFileSync(join(json(join(dir, "setup.json")).stage, "plugins/pstack/README.md"), "edited after the drive\n");
  const moved = verify(["check", root]);
  expect([moved.status, moved.lines[0]]).toEqual([1, "FAIL surface 0/2 | behavior NOT BUILT | round 1"]);
  expect(moved.stdout).toContain("| S2 the plugin loads from the tree | fail | context.stage-hash: saw stage hash ");
  expect(json(join(dir, "receipt.json"))).toMatchObject({ verdict: "FAIL", checks: [{ failed: ["S2.context.stage-hash"] }, { failed: ["S3.startup.stage-hash"] }] });
}, LONG);

test.skipIf(process.platform === "win32")("a failed run counts a round, and a pass starts the count over", () => {
  const repo = productRepo();
  const root = tempDir();
  const run = () => verify(["--tree", repo, "--evidence", root]);
  writeFileSync(join(repo, "VERSION"), "9.9.9\n");
  const failing = run();
  expect([failing.status, failing.lines[0]]).toEqual([1, "FAIL surface 0/2 | behavior NOT BUILT | round 1"]);
  expect(failing.stdout).toContain("context.plugin-version: saw plugin version 0.9.158, want the stage's VERSION, 9.9.9");
  git(repo, "checkout", "--quiet", "VERSION");
  expect(run().lines[0]).toBe("PASS surface 2/2 | behavior NOT BUILT | round 2");
  expect(run().lines[0]).toBe("PASS surface 2/2 | behavior NOT BUILT | round 1");
}, LONG);

test.skipIf(process.platform === "win32")("--flow runs one check, and the receipt shows the other was skipped", () => {
  const root = tempDir();
  const run = verify(["--flow", "S2", "--tree", productRepo(), "--evidence", root]);
  expect([run.status, run.lines[0]]).toEqual([0, "PASS surface 1/2 | behavior NOT BUILT | round 1"]);
  const [dir] = runsOf(root);
  expect(readdirSync(join(dir, "traces"))).toEqual(["S2"]);
  expect(json(join(dir, "receipt.json")).checks).toEqual([
    { id: "S2", tier: "surface", verdict: "pass" },
    { id: "S3", tier: "surface", verdict: "skipped", reason: "not selected" },
  ]);
}, LONG);

test("without a CLI the run is skipped, and fails where a CLI is required", () => {
  const repo = productRepo();
  const skipped = verify(["--tree", repo, "--evidence", tempDir()], { PSTACK_VERIFY_CLAUDE: "" });
  expect([skipped.status, skipped.lines[0]]).toEqual([0, "SKIPPED surface: claude is not on PATH | behavior NOT BUILT | round 1"]);
  const required = verify(["--tree", repo, "--evidence", tempDir()], { PSTACK_VERIFY_CLAUDE: "", PSTACK_VERIFY_REQUIRE_CLI: "1" });
  expect([required.status, required.lines[0]]).toEqual([1, "FAIL surface: claude is not on PATH | behavior NOT BUILT | round 1"]);
}, LONG);

test.skipIf(process.platform === "win32")("the last five runs are kept with their stages", () => {
  const repo = productRepo();
  const root = tempDir();
  for (let i = 0; i < 6; i += 1) verify(["--flow", "S2", "--tree", repo, "--evidence", root]);
  const kept = runsOf(root);
  expect(kept.length).toBe(5);
  const stages = kept.map((dir) => json(join(dir, "setup.json")).stage);
  expect(stages.map((stage) => existsSync(stage))).toEqual([true, true, true, true, true]);
  expect(readdirSync(dirname(dirname(stages[0]))).length).toBe(5);
}, LONG);

test("a wrong argument is a usage error, with nothing run", () => {
  const usage = (args) => {
    const run = verify(args);
    return [run.status, run.stdout, run.stderr.split("\n")[0]];
  };
  const first = "usage: bun tools/verify.mjs [--tier surface|behavior|all] [--flow <id>] [--tree <checkout>] [--evidence <dir>] [--jobs 1-3]";
  expect(usage(["--tier", "nope"])).toEqual([2, "", first]);
  expect(usage(["--jobs", "4"])).toEqual([2, "", first]);
  expect(usage(["--tree"])).toEqual([2, "", first]);
  expect(usage(["check"])).toEqual([2, "", first]);
  expect(usage(["--flow", "S9"])).toEqual([2, "", "no flow S9; flows: S2, S3"]);
}, LONG);
