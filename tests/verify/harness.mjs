// Shared by the tests under tests/verify: temp directories, and the evidence
// directory a run would leave, built from the recorded traces. A test file
// registers `cleanup` itself, because a hook registered here would belong to
// whichever file imported this module first.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256, stageHash } from "../../tools/verify/stage.mjs";
import { FIXTURES } from "./scrub.mjs";

const RUNS = { S2: "context", S3: "startup" };

const made = [];
export function cleanup() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pstack-verify-test-")));
  made.push(dir);
  return dir;
}

export function git(dir, ...args) {
  const identity = ["-c", "user.name=verify-test", "-c", "user.email=verify-test@example.invalid", "-c", "commit.gpgsign=false"];
  const result = spawnSync("git", ["-C", dir, ...identity, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

// A repository whose product paths are the fixture stage, so the recorded
// traces are true of it, plus one file outside every watched path.
export function productRepo() {
  const dir = tempDir();
  cpSync(join(FIXTURES, "stage"), dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "not a product path\n");
  git(dir, "init", "--quiet");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "product");
  return dir;
}

// The directory a run leaves for the checker: a stage, setup's record of it,
// and per check one trace with the sidecar the driver would have written.
// `edits[id]` picks a recording (`fixture`), changes its events (`events`) or
// its text (`raw`), overrides sidecar fields, adds a transcript, or leaves
// the trace out (`absent`). `stage` shapes the stage before setup hashes it
// and `moved` changes it afterwards.
export function evidence(edits = {}) {
  const dir = tempDir();
  const stage = join(dir, "stage");
  cpSync(join(FIXTURES, "stage"), stage, { recursive: true });
  edits.stage?.(stage);
  const setup = {
    run: "fixture",
    round: 1,
    subject_id: "fixture",
    stage,
    stage_hash: stageHash(stage),
    cli: { path: "claude", version: "2.1.332", missing: false, required: false, problem: null },
    selection: { tier: "all", flow: null },
    selected: Object.keys(RUNS),
    ...edits.setup,
  };
  writeFileSync(join(dir, "setup.json"), JSON.stringify(setup));
  edits.moved?.(stage);

  for (const [id, run] of Object.entries(RUNS)) {
    const edit = edits[id] ?? {};
    if (edit.absent) continue;
    const recorded = readFileSync(join(FIXTURES, `${edit.fixture ?? "untouched"}.${id}.${run}.jsonl`), "utf8").replaceAll("<STAGE>", stage);
    const events = recorded.trimEnd().split("\n").map((line) => JSON.parse(line));
    const edited = edit.events?.(events) ?? events;
    const text = edited.map((event) => `${JSON.stringify(event)}\n`).join("");
    const trace = edit.raw?.(text) ?? text;
    const file = (suffix) => join(dir, "traces", id, `${run}${suffix}`);
    mkdirSync(join(dir, "traces", id), { recursive: true });
    writeFileSync(file(".jsonl"), trace);
    if (edit.transcript) writeFileSync(file(".transcript.jsonl"), edit.transcript);
    const argv = ["claude", "-p", "--plugin-dir", join(stage, "plugins/pstack"), "--model", "haiku", "--output-format", "stream-json", "--verbose"];
    writeFileSync(file(".sidecar.json"), JSON.stringify({ argv, exit_code: 0, trace_sha256: sha256(trace), ...edit.sidecar }));
  }
  return dir;
}

