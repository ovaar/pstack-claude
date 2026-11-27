// Shared by the tests under tests/verify: temp directories, repositories, and
// the evidence directory a run would leave, built from the recorded traces.
// A test file registers `cleanup` itself, because a hook registered here
// would belong to whichever file imported this module first.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLUGIN } from "../../tools/plugin.mjs";
import { CHECKS_DIR, FLOWS_DIR, listDir, loadDir } from "../../tools/verify/paths.mjs";
import { gitEnv } from "../../tools/verify/setup.mjs";
import { sha256, stageHash, stageSeal } from "../../tools/verify/stage.mjs";
import { FIXTURES } from "./scrub.mjs";

// The line of skills/how/SKILL.md that B4 looks for in a subagent's prompt.
const HOW_BRIEF = "> You are writing an architectural explanation for a senior engineer. Explore the codebase and write an explanation they could read.";

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
  const result = spawnSync("git", ["-C", dir, ...identity, ...args], { encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

// Makes `dir` a repository of its own and commits what it holds. It checks
// where the commit would land first: these tests once committed a fixture
// tree onto the branch they were run from.
export function commitAll(dir, message) {
  git(dir, "init", "--quiet");
  const landsIn = realpathSync(git(dir, "rev-parse", "--absolute-git-dir").trim());
  if (landsIn !== join(realpathSync(dir), ".git")) throw new Error(`a commit in ${dir} would land in ${landsIn}`);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
  return dir;
}

const recorded = (name) => readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");
const eventsOf = (text) => text.trimEnd().split("\n").map((line) => JSON.parse(line));

// The committed stage holds the two files every trace is checked against.
// The skill directories, which only a check that lists them needs, are
// written from the recording they have to agree with.
export function fixtureStage(dir, { skills = false } = {}) {
  cpSync(join(FIXTURES, "stage"), dir, { recursive: true });
  if (!skills) return dir;
  const init = eventsOf(recorded("untouched.S2.context")).find((event) => event.subtype === "init");
  for (const name of init.skills.filter((skill) => skill.startsWith("pstack:")).map((skill) => skill.slice("pstack:".length))) {
    mkdirSync(join(dir, PLUGIN, "skills", name), { recursive: true });
    writeFileSync(join(dir, PLUGIN, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n${name === "how" ? `\n${HOW_BRIEF}\n` : ""}`);
  }
  return dir;
}

// A repository whose product paths are the fixture stage, so the recorded
// traces are true of it, plus one file outside every watched path.
export function productRepo() {
  const dir = fixtureStage(tempDir(), { skills: true });
  writeFileSync(join(dir, "README.md"), "not a product path\n");
  return commitAll(dir, "product");
}

// Two checks that never change, for the tests of the checker itself and of
// what it writes: those tests must not move when a shipped check does.
export const ENGINE = {
  checks: join(import.meta.dir, "engine"),
  runs: [
    { check: "E1", name: "context", args: ["/context"], fixture: "untouched.S2.context" },
    { check: "E2", name: "startup", args: ["--input-format", "stream-json"], fixture: "untouched.S3.startup" },
  ],
};

// One shipped check with the runs its flow lists, each with the recording
// named after it, over a stage with skill directories. The other shipped
// checks show as not selected.
export async function shipped(id) {
  const flow = (await loadDir(FLOWS_DIR)).find((each) => each.id === id);
  return { checks: CHECKS_DIR, skills: true, behavior: flow.tier === "behavior", runs: flow.runs.map((run) => ({ check: id, name: run.name, args: run.args ?? [], fixture: `untouched.${id}.${run.name}` })) };
}

// The directory a run leaves for the checker: a stage, setup's record of the
// run, and per run one trace with the sidecar the driver would have written.
// `edits[check]` picks a recording (`fixture`), changes its events (`events`)
// or its text (`raw`), changes the recorded `argv` or other sidecar fields,
// adds a transcript or stderr, or leaves the trace out (`absent`). `stage` shapes the stage before setup
// records it and `moved` changes it afterwards.
export function evidence({ checks, runs, skills, behavior = false }, edits = {}) {
  const dir = tempDir();
  const stage = fixtureStage(join(dir, "stage"), { skills });
  const sandbox = join(dir, "sandbox");
  edits.stage?.(stage);
  const sessions = runs.map((run) => {
    // `edits[<check>.<run>]` changes one run of a check, and wins over
    // `edits[<check>]`, which changes every run of it.
    const edit = { ...edits[run.check], ...edits[`${run.check}.${run.name}`] };
    const events = eventsOf(recorded(edit.fixture ?? run.fixture).replaceAll("<STAGE>", stage).replaceAll("<SANDBOX>", sandbox));
    // Setup plans a session where the recorded one ran.
    const cwd = events.find((event) => event.subtype === "init")?.cwd ?? join(sandbox, run.check, run.name, "cwd");
    return { ...run, edit, events, cwd };
  });
  const setup = {
    run: "fixture",
    round: 1,
    subject_id: "fixture",
    tree_id: "fixture",
    stage,
    stage_hash: stageHash(stage),
    stage_seal: stageSeal(stage),
    sandbox,
    cli: { path: "claude", real_path: "/opt/claude/2.1.332", sha256: "c".repeat(64), version: "2.1.332", stand_in: null, missing: false, required: false, problem: null },
    selection: { tier: "all", flow: null },
    // The recordings of the model tier were made signed in as a person.
    behavior: behavior ? { mode: "local", credential: [], required: false, planned: { max_usd: 0.45, max_turns: 15 } } : null,
    selected: [...new Set(runs.map((run) => run.check))],
    checks: listDir(checks),
    sessions: sessions.map(({ check, name, cwd }) => ({ check, name, cwd })),
    ...edits.setup,
  };
  writeFileSync(join(dir, "setup.json"), JSON.stringify(setup));
  edits.moved?.(stage);

  for (const { check, name, args, edit, events } of sessions) {
    if (edit.absent) continue;
    const text = (edit.events?.(events) ?? events).map((event) => `${JSON.stringify(event)}\n`).join("");
    const trace = edit.raw?.(text) ?? text;
    const file = (suffix) => join(dir, "traces", check, `${name}${suffix}`);
    mkdirSync(join(dir, "traces", check), { recursive: true });
    writeFileSync(file(".jsonl"), trace);
    if (edit.transcript) writeFileSync(file(".transcript.jsonl"), edit.transcript);
    if (edit.stderr) writeFileSync(file(".stderr"), edit.stderr);
    const started = [setup.cli.path, "-p", "--plugin-dir", join(stage, PLUGIN), "--model", "haiku", "--output-format", "stream-json", "--verbose", ...args];
    writeFileSync(file(".sidecar.json"), JSON.stringify({ argv: edit.argv?.(started) ?? started, exit_code: 0, trace_sha256: sha256(trace), ...edit.sidecar }));
  }
  return dir;
}
