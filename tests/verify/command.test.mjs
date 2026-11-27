// The whole command, offline. A stand-in for the CLI replays the recorded
// traces, so setup, the driver, the checker and the evidence writer run as
// one, against a small repository whose product paths match the recordings.
// A run against the stand-in is never PASS; that word is tested on the
// checker. Nothing here names the shipped checks beyond S2 and S3, which the
// tests about selection need: every other assertion is per check or a count.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { sha256 } from "../../tools/verify/stage.mjs";
import { cleanup, commitAll, git, productRepo, tempDir } from "./harness.mjs";

// Sessions get their directories under TMPDIR, so each test gets a temp
// directory that goes away with it.
let tmp;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(cleanup);

const VERIFY = join(import.meta.dir, "../../tools/verify.mjs");
const FAKE_CLI = join(import.meta.dir, "fake-claude.mjs");
const NAMED = "named by PSTACK_VERIFY_CLAUDE";
// The stand-in's shebang needs bun, and "no CLI" needs a PATH without claude.
const PATH = [dirname(process.execPath), ...process.env.PATH.split(delimiter).filter((dir) => !existsSync(join(dir, "claude")))].join(delimiter);
const SESSION_VARIABLES = ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR", ...("LANG" in process.env ? ["LANG"] : [])].sort();
const HOSTILE = { PSTACK_SESSION_HOOK: "off", PLUGIN_ROOT: "/x", MINIMAX_PLUGIN_ROOT: "/x", ANTHROPIC_API_KEY: "dummy", CLAUDE_CODE_OAUTH_TOKEN: "dummy", CLAUDECODE: "1" };

// What the surrounding job exports must not decide a test: a job that
// requires the CLI, or one started from a git hook.
function verify(args, env = {}) {
  const { PSTACK_VERIFY_REQUIRE_CLI, GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [VERIFY, ...args], { encoding: "utf8", env: { ...inherited, PATH, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, ...env } });
  return { status: result.status, lines: result.stdout.split("\n"), stdout: result.stdout, stderr: result.stderr };
}

// The parts of a verdict line that hold however many checks there are.
function tally(line) {
  const [, word, passed, of, round] = line.match(/^(\S+) surface (\d+)\/(\d+) \| .* \| round (\d+)$/) ?? [];
  return { word, failed: of - passed, of: Number(of), round: Number(round) };
}

const runsOf = (root) => readdirSync(join(root, "runs")).sort().map((run) => join(root, "runs", run));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const tracesOf = (dir) => readdirSync(join(dir, "traces")).flatMap((check) => readdirSync(join(dir, "traces", check)).filter((file) => file.endsWith(".sidecar.json")).map((file) => join(dir, "traces", check, file.slice(0, -".sidecar.json".length))));
const LONG = 60_000;

test.skipIf(process.platform === "win32")("a full run passes every check, hands a session only the allow-listed variables, and leaves nothing behind", () => {
  const repo = productRepo();
  const root = tempDir();
  const run = verify(["--tier", "surface", "--tree", repo, "--evidence", root], HOSTILE);
  expect(tally(run.lines[0])).toMatchObject({ word: "STAND-IN", failed: 0, round: 1 });
  expect(run.status).toBe(0);

  const [dir] = runsOf(root);
  expect(run.lines.at(-2)).toBe(`evidence: ${dir}`);
  const report = readFileSync(join(dir, "evidence.md"), "utf8").split("\n");
  expect(report[0]).toBe(run.lines[0]);
  expect(report).toContain(`- CLI stand-in: ${NAMED}. No verdict on the claude a user has.`);

  const receipt = json(join(dir, "receipt.json"));
  expect(receipt).toMatchObject({ verdict: "STAND-IN", selection: { tier: "surface", flow: null }, cli_version: "2.1.332", cli_stand_in: NAMED, cli_sha256: sha256(readFileSync(FAKE_CLI)), cost_usd: 0 });
  expect(receipt.checks.length).toBe(tally(run.lines[0]).of);
  expect(receipt.checks.filter((each) => each.verdict !== "pass")).toEqual([]);
  expect(receipt.checks.map((each) => each.id)).toEqual(json(join(dir, "setup.json")).checks.map((each) => each.id));

  const traces = tracesOf(dir);
  expect(traces.length).toBeGreaterThanOrEqual(2);
  // The variables a run's flow declares reach that run and no other, even
  // with the same name exported by the surrounding job.
  const sessions = json(join(dir, "setup.json")).sessions;
  for (const trace of traces) {
    const [name, check] = trace.split("/").reverse();
    const added = Object.keys(sessions.find((session) => session.check === check && session.name === name).env);
    const env = [...SESSION_VARIABLES, ...added].sort();
    expect(readFileSync(`${trace}.transcript.jsonl`, "utf8").split("\n").map((line) => (line ? JSON.parse(line) : null))[0]).toEqual({ type: "stand-in", env });
    expect(json(`${trace}.sidecar.json`)).toMatchObject({ env, exit_code: 0, timed_out: false });
  }

  expect(existsSync(join(dir, "stage/VERSION"))).toBe(true);
  expect(readdirSync(tmp)).toEqual([]);
  expect(git(repo, "status", "--porcelain")).toBe("");
}, LONG);

test.skipIf(process.platform === "win32")("the checker rerun alone agrees with the run, fails once the stage is edited, and leaves the run's receipt alone", () => {
  const root = tempDir();
  const first = verify(["--tree", productRepo(), "--evidence", root]);
  const [dir] = runsOf(root);
  const receipt = readFileSync(join(dir, "receipt.json"), "utf8");
  const rerun = verify(["check", dir]);
  expect([rerun.status, rerun.lines[0]]).toEqual([0, `RECHECK ${first.lines[0]}`]);
  expect(json(join(dir, "receipt.recheck.json"))).toMatchObject({ verdict: "STAND-IN", line: rerun.lines[0], rechecked_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });

  writeFileSync(join(dir, "stage/plugins/pstack/README.md"), "edited after the drive\n");
  const moved = verify(["check", root]);
  expect(moved.status).toBe(1);
  expect(moved.lines[0]).toStartWith("RECHECK FAIL surface 0/");
  expect(moved.stdout).toContain("| S2 the plugin loads from the tree | fail | context.stage-hash: saw stage hash ");
  const recheck = json(join(dir, "receipt.recheck.json"));
  expect(recheck.verdict).toBe("FAIL");
  expect(recheck.checks.find((each) => each.id === "S3").failed).toEqual(["S3.startup.stage-hash", "S3.startup.stage-seal"]);
  expect(readFileSync(join(dir, "receipt.json"), "utf8")).toBe(receipt);
}, LONG);

test.skipIf(process.platform === "win32")("a failed run counts a round, and a run against a stand-in does not start the count over", () => {
  const repo = productRepo();
  const root = tempDir();
  const run = () => verify(["--tree", repo, "--evidence", root]);
  writeFileSync(join(repo, "VERSION"), "9.9.9\n");
  const failing = run();
  expect(failing.status).toBe(1);
  expect(tally(failing.lines[0])).toMatchObject({ word: "FAIL", round: 1 });
  expect(failing.stdout).toContain("context.plugin-version: saw plugin version 0.9.158, want the stage's VERSION, 9.9.9");
  git(repo, "checkout", "--quiet", "VERSION");
  expect(tally(run().lines[0])).toMatchObject({ word: "STAND-IN", failed: 0, round: 2 });
  expect(tally(run().lines[0])).toMatchObject({ word: "STAND-IN", failed: 0, round: 2 });
}, LONG);

test.skipIf(process.platform === "win32")("--flow runs one check, and the receipt shows every other one was left out", () => {
  const root = tempDir();
  const run = verify(["--flow", "S2", "--tree", productRepo(), "--evidence", root]);
  expect(run.status).toBe(0);
  const [dir] = runsOf(root);
  expect(readdirSync(join(dir, "traces"))).toEqual(["S2"]);
  const { checks } = json(join(dir, "receipt.json"));
  expect(tally(run.lines[0])).toMatchObject({ word: "STAND-IN", failed: checks.length - 1 });
  expect(checks.find((each) => each.id === "S2")).toEqual({ id: "S2", tier: "surface", verdict: "pass" });
  expect(checks.find((each) => each.id === "S3")).toEqual({ id: "S3", tier: "surface", verdict: "skipped", reason: "not selected" });
  expect(checks.filter((each) => each.id !== "S2" && each.verdict !== "skipped")).toEqual([]);
}, LONG);

test("without a CLI the run is skipped, and fails where a CLI is required or was named and is not there", () => {
  const repo = productRepo();
  const first = (env) => {
    const run = verify(["--tree", repo, "--evidence", tempDir()], env);
    return [run.status, run.lines[0]];
  };
  expect(first({ PSTACK_VERIFY_CLAUDE: "" })).toEqual([0, "SKIPPED surface: claude is not on PATH | behavior NOT BUILT | round 1"]);
  expect(first({ PSTACK_VERIFY_CLAUDE: "", PSTACK_VERIFY_REQUIRE_CLI: "1" })).toEqual([1, "FAIL surface: claude is not on PATH | behavior NOT BUILT | round 1"]);
  expect(first({ PSTACK_VERIFY_CLAUDE: join(tmp, "no-such-claude") })).toEqual([1, "FAIL surface: PSTACK_VERIFY_CLAUDE does not name an executable | behavior NOT BUILT | round 1"]);
}, LONG);

test("a tree with nothing to verify fails before anything runs, and leaves no run behind", () => {
  const repo = tempDir();
  writeFileSync(join(repo, "README.md"), "no product here\n");
  commitAll(repo, "empty");
  const root = tempDir();
  const run = verify(["--tree", repo, "--evidence", root]);
  expect([run.status, run.stdout]).toEqual([1, ""]);
  expect(run.stderr).toStartWith(`FAIL: ${repo} holds none of plugins/pstack, .claude-plugin, VERSION`);
  expect(readdirSync(join(root, "runs"))).toEqual([]);
  expect(readdirSync(tmp)).toEqual([]);
}, LONG);

// One symlink is all it would take to put the stand-in in the CLI's place.
test.skipIf(process.platform === "win32")("the stand-in found on PATH under the name claude is still a stand-in", () => {
  const bin = tempDir();
  symlinkSync(FAKE_CLI, join(bin, "claude"));
  const root = tempDir();
  const run = verify(["--tree", productRepo(), "--evidence", root], { PSTACK_VERIFY_CLAUDE: "", PATH: [bin, PATH].join(delimiter) });
  expect(tally(run.lines[0])).toMatchObject({ word: "STAND-IN", failed: 0 });
  expect(json(join(runsOf(root)[0], "receipt.json")).cli_stand_in).toBe('calls itself "2.1.332 (stand-in for tests)"');
}, LONG);

test.skipIf(process.platform === "win32")("the last five runs are kept with their stages", () => {
  const repo = productRepo();
  const root = tempDir();
  for (let i = 0; i < 6; i += 1) verify(["--flow", "S2", "--tree", repo, "--evidence", root]);
  const kept = runsOf(root);
  expect(kept.length).toBe(5);
  expect(kept.map((dir) => existsSync(join(dir, "stage/VERSION")))).toEqual([true, true, true, true, true]);
  expect(readdirSync(tmp)).toEqual([]);
}, LONG);

// The second run starts, ends and prunes while the first is still asking the
// CLI for its version, which is after the first built its stage.
test.skipIf(process.platform === "win32")("a run that ends while another is in setup leaves the other's stage alone", () => {
  const repo = productRepo();
  const root = tempDir();
  const nested = [process.execPath, VERIFY, "--tree", repo, "--evidence", root];
  const cli = join(tempDir(), "claude-that-waits.mjs");
  writeFileSync(
    cli,
    `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
if (process.argv.includes("--version")) spawnSync(${JSON.stringify(nested[0])}, ${JSON.stringify(nested.slice(1))}, { env: { ...process.env, PSTACK_VERIFY_CLAUDE: ${JSON.stringify(FAKE_CLI)} } });
await import(${JSON.stringify(FAKE_CLI)});
`,
    { mode: 0o755 },
  );
  const outer = verify(["--tree", repo, "--evidence", root], { PSTACK_VERIFY_CLAUDE: cli });
  expect(runsOf(root).length).toBe(2);
  expect(outer.stdout).not.toContain("the stage is gone");
  expect(tally(outer.lines[0])).toMatchObject({ word: "STAND-IN", failed: 0 });
}, LONG);

// A git hook in a linked worktree runs with GIT_DIR exported.
test.skipIf(process.platform === "win32")("with GIT_DIR exported, the tree named by --tree is still the one verified", () => {
  const repo = productRepo();
  const other = tempDir();
  writeFileSync(join(other, "README.md"), "another repository\n");
  commitAll(other, "other");
  const before = [git(other, "rev-parse", "HEAD"), git(other, "status", "--porcelain"), readFileSync(join(other, ".git/config"), "utf8")];
  const plain = verify(["--tree", repo, "--evidence", tempDir()]);
  const root = tempDir();
  const hooked = verify(["--tree", repo, "--evidence", root], { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other });
  expect(hooked.lines[0]).toBe(plain.lines[0]);
  expect(tally(hooked.lines[0])).toMatchObject({ word: "STAND-IN", failed: 0 });
  expect(json(join(runsOf(root)[0], "receipt.json")).subject_id).toBe(plain.lines.find((line) => line.startsWith("- subject_id: ")).slice("- subject_id: ".length));
  expect([git(other, "rev-parse", "HEAD"), git(other, "status", "--porcelain"), readFileSync(join(other, ".git/config"), "utf8")]).toEqual(before);
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
  expect(usage(["--flow", "S9"])[2]).toMatch(/^no flow S9; flows: .*\bS2\b.*\bS3\b/);
}, LONG);
