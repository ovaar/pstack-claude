// Shared by the tests under tests/verify: temp directories, repositories, and
// the evidence directory a run would leave, built from the recorded traces.
// A test file registers `cleanup` itself, because a hook registered here
// would belong to whichever file imported this module first.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLUGIN } from "../../tools/plugin.mjs";
import { CHECKS_DIR, FLOWS_DIR, listDir, loadDir } from "../../tools/verify/paths.mjs";
import { gitEnv } from "../../tools/verify/setup.mjs";
import { sha256, stageHash, stageSeal } from "../../tools/verify/stage.mjs";
import { FIXTURES } from "./scrub.mjs";

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

const FRONTMATTER = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n`;

// The committed stage holds the files every trace is checked against: the
// hook and its mandate, the version, the plugin manifest and the marketplace
// manifest. The skill and agent directories, which only a check that lists
// them needs, are written from the recordings they have to agree with: `skills`
// is true for the tree the recordings were made of, the plugin's skills and
// agents as `plugin validate` listed them, with the ones the S2 recording did
// not load marked as hidden from the slash menu, or a list of names, each
// hidden when it says so; `agents` is a list of names.
export function fixtureStage(dir, { skills = false, agents = [] } = {}) {
  cpSync(join(FIXTURES, "stage"), dir, { recursive: true });
  const bare = (name) => name.slice(name.indexOf(":") + 1);
  const whole = skills === true ? eventsOf(recorded("untouched.S1.validate"))[0].provides : null;
  const loaded = skills === true ? eventsOf(recorded("untouched.S2.context")).find((event) => event.subtype === "init").skills : [];
  const listed = whole ? whole.skills.map((name) => ({ name: bare(name), hidden: !loaded.includes(name) })) : skills || [];
  for (const { name, hidden } of listed) {
    mkdirSync(join(dir, PLUGIN, "skills", name), { recursive: true });
    writeFileSync(join(dir, PLUGIN, "skills", name, "SKILL.md"), FRONTMATTER({ name, ...(hidden ? { "user-invocable": false } : {}) }));
  }
  for (const name of whole ? whole.agents.map(bare) : agents) {
    mkdirSync(join(dir, PLUGIN, "agents"), { recursive: true });
    writeFileSync(join(dir, PLUGIN, "agents", `${name}.md`), FRONTMATTER({ name, description: "x" }));
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
  return {
    checks: CHECKS_DIR,
    tree: { skills: true },
    runs: flow.runs.map((run) => ({ check: id, name: run.name, args: run.args ?? [], command: run.command, env: run.env ?? {}, files: run.files ?? {}, fixture: `untouched.${id}.${run.name}` })),
  };
}

// The directory a run leaves for the checker: a stage, setup's record of the
// run, and per run one trace with the sidecar the driver would have written.
// `edits[check]` picks a recording (`fixture`), changes its events (`events`)
// or its text (`raw`), changes the recorded `argv` or other sidecar fields,
// adds a transcript or stderr, or leaves the trace out (`absent`). `stage` shapes the stage before setup
// records it, `setup` changes setup's record, and `moved` changes the stage afterwards.
export function evidence({ checks, runs, skills, tree = { skills } }, edits = {}) {
  const dir = tempDir();
  const stage = fixtureStage(join(dir, "stage"), tree);
  const sandbox = join(dir, "sandbox");
  edits.stage?.(stage);
  const sessions = runs.map((run) => {
    const edit = edits[run.check] ?? {};
    const fixture = edit.fixture ?? run.fixture;
    const named = (text) => text.replaceAll("<STAGE>", stage).replaceAll("<SANDBOX>", sandbox);
    const events = eventsOf(named(recorded(fixture)));
    const transcript = existsSync(join(FIXTURES, `${fixture}.transcript.jsonl`)) ? named(recorded(`${fixture}.transcript`)) : null;
    // Setup plans a session where the recorded one ran.
    const cwd = events.find((event) => event.subtype === "init")?.cwd ?? join(sandbox, run.check, run.name, "cwd");
    return { ...run, edit, events, cwd, transcript };
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
    selected: [...new Set(runs.map((run) => run.check))],
    checks: listDir(checks),
    sessions: sessions.map(({ check, name, cwd, env = {}, files = {} }) => ({ check, name, cwd, env, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, sha256(text)])) })),
  };
  // `setup` changes what setup recorded: a function of the record, or fields.
  Object.assign(setup, typeof edits.setup === "function" ? edits.setup(setup) : edits.setup);
  writeFileSync(join(dir, "setup.json"), JSON.stringify(setup));
  edits.moved?.(stage);

  for (const { check, name, args, command, env = {}, edit, events, transcript } of sessions) {
    if (edit.absent) continue;
    const text = (edit.events?.(events) ?? events).map((event) => `${JSON.stringify(event)}\n`).join("");
    const trace = edit.raw?.(text) ?? text;
    const file = (suffix) => join(dir, "traces", check, `${name}${suffix}`);
    mkdirSync(join(dir, "traces", check), { recursive: true });
    writeFileSync(file(".jsonl"), trace);
    const lines = edit.transcript ?? transcript;
    if (lines) writeFileSync(file(".transcript.jsonl"), edit.transcriptEdit ? edit.transcriptEdit(lines) : lines);
    if (edit.stderr) writeFileSync(file(".stderr"), edit.stderr);
    const places = { "<plugin>": join(stage, PLUGIN), "<stage>": stage };
    const started = command ? [setup.cli.path, ...command.map((word) => places[word] ?? word)] : [setup.cli.path, "-p", "--plugin-dir", join(stage, PLUGIN), "--model", "haiku", "--output-format", "stream-json", "--verbose", ...args];
    const names = [...new Set(["PATH", "TMPDIR", "LANG", "HOME", "CLAUDE_CONFIG_DIR", ...Object.keys(env)])].sort();
    writeFileSync(file(".sidecar.json"), JSON.stringify({ argv: edit.argv?.(started) ?? started, env: names, exit_code: 0, trace_sha256: sha256(trace), ...edit.sidecar }));
  }
  return dir;
}
