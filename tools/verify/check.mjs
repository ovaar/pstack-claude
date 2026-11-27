// The checker, the third role: a pure function from an evidence directory to
// verdicts. It starts no process, writes no file and reads traces only
// through trace.mjs. Every verdict is recomputed from structured events,
// never from what a model wrote and never from an exit code. Before a check's
// own assertions count, the integrity rules confirm the driver ran what it
// was meant to run: the session was started with the declared arguments, in
// the directory setup made, with the plugin from the stage; the stage did not
// move; the trace is the one the driver hashed; a zero-model run called no
// model.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN } from "../plugin.mjs";
import { CHECKS_DIR, loadDir } from "./paths.mjs";
import { SESSION_FILES, sha256, stageHash, stageSeal } from "./stage.mjs";
import { readRun, runNames } from "./trace.mjs";

const PIN = JSON.parse(readFileSync(new URL("./cli-pin.json", import.meta.url), "utf8"));

export const TIERS = ["surface", "behavior"];
const FAILED = ["fail", "unobservable", "error"];
const SLOW_HOOK_MS = 1000;
const RERUN = "run the verifier again";

// How a session must have been started. The driver holds its own copy on
// purpose: a flag added there alone fails the argv rule. Without --bare or
// --safe-mode, which skip plugin hooks.
const sessionArgv = (cli, plugin, args) => [cli, "-p", "--plugin-dir", plugin, "--model", "haiku", "--output-format", "stream-json", "--verbose", ...args];
// A run may instead be one subcommand of the CLI, which a check declares in
// full, with the stage's directories named as the driver names them.
const commandArgv = (cli, command, places) => [cli, ...command.map((word) => places[word] ?? word)];
// The variables a session has whatever its flow says; a check declares the
// ones it adds.
const BASE_ENV = ["PATH", "TMPDIR", "LANG", "HOME", "CLAUDE_CONFIG_DIR"];
const REQUIRED_ENV = ["HOME", "CLAUDE_CONFIG_DIR"];
const entries = (map) => JSON.stringify(Object.entries(map ?? {}).sort());

// Thrown when a record a check needs is not in the evidence. The check is
// then unobservable, which counts as failed: no verdict rests on an absence.
class Missing extends Error {}
const missing = (what) => {
  throw new Missing(what);
};

function readStage(setup) {
  const at = (path) => join(setup.stage, path);
  const read = (path) => {
    try {
      return readFileSync(at(path));
    } catch {
      return null;
    }
  };
  return {
    root: setup.stage,
    plugin: at(PLUGIN),
    hash: stageHash(setup.stage),
    seal: stageSeal(setup.stage),
    version: read("VERSION")?.toString("utf8").trim() ?? null,
    // All a check file may ask of the stage.
    offered: {
      // Where the CLI was told to look, as it reports paths back.
      root: setup.stage,
      plugin: at(PLUGIN),
      sha256: (path) => {
        const bytes = read(path);
        return bytes && sha256(bytes);
      },
      text: (path) => read(path)?.toString("utf8") ?? null,
      list: (path) => {
        try {
          return readdirSync(at(path)).sort();
        } catch {
          return [];
        }
      },
    },
  };
}

// A rule that cannot be evaluated is left out, not failed: a trace with no
// init fails `init-present` once instead of dragging the plugin rules along.
function integrity(run, check, setup, stage) {
  const rules = [];
  const rule = (id, ok, saw, want) => rules.push({ id: `${run.name}.${id}`, ok, saw, want });
  const init = run.trace.init();
  const results = run.trace.results();

  rule("stage-hash", stage.hash !== null && stage.hash === setup.stage_hash, stage.hash === null ? `the stage is gone; ${RERUN}` : `stage hash ${stage.hash}`, `the stage hash setup recorded, ${setup.stage_hash}`);
  if (stage.seal !== null) {
    const sealed = stage.seal === setup.stage_seal;
    rule("stage-seal", sealed, sealed ? "no entry of the stage changed since setup" : "an entry of the stage changed since setup, or was changed and put back", "every entry of the stage as setup left it");
  }
  rule("trace-sha256", run.sha256 === run.recordedSha256, `trace sha256 ${run.sha256}`, `the sha256 in the sidecar, ${run.recordedSha256}`);

  const command = check.commands?.[run.name];
  const declared = check.args?.[run.name];
  const places = { "<plugin>": stage.plugin, "<stage>": stage.root };
  const wanted = command ? commandArgv(setup.cli.path, command, places) : declared && sessionArgv(setup.cli.path, stage.plugin, declared);
  rule(
    "argv",
    Boolean(wanted) && JSON.stringify(run.argv) === JSON.stringify(wanted),
    `argv ${JSON.stringify(run.argv)}`,
    wanted ? `exactly ${JSON.stringify(wanted)}` : `a run the check file declares arguments for, and it declares none for ${run.name}`,
  );

  // What a run adds to its sandbox is what its check declares: setup's record
  // of the variables and of the digests of the files it wrote, and the names
  // the session's environment held. Without this, a variable a flow forgot
  // to drop would reach every run that follows it.
  const planned = (setup.sessions ?? []).find((session) => session.check === check.id && session.name === run.name);
  const env = check.env?.[run.name] ?? {};
  const files = Object.fromEntries(Object.entries(check.files?.[run.name] ?? {}).map(([name, text]) => [name, sha256(text)]));
  const allowed = [...BASE_ENV, ...Object.keys(env)];
  const stray = (run.env ?? []).filter((name) => !allowed.includes(name));
  const lacking = [...REQUIRED_ENV, ...Object.keys(env)].filter((name) => !(run.env ?? []).includes(name));
  const foreign = Object.keys(files).filter((name) => !SESSION_FILES.includes(name));
  const recorded = Boolean(planned) && entries(planned.env) === entries(env) && entries(planned.files) === entries(files);
  rule(
    "extras",
    recorded && run.env !== null && !stray.length && !lacking.length && !foreign.length,
    foreign.length ? `the check declares ${foreign.join(", ")}, which no run may write` : !planned ? "no record in setup of this run" : run.env === null ? "no environment in the sidecar" : `setup recorded ${entries(planned.env)} and ${entries(planned.files)}; the session had ${run.env.join(", ")}${stray.length ? `, of which ${stray.join(", ")} are no variable of a session` : ""}`,
    `exactly the variables ${entries(env)} and the files ${entries(files)} the check declares, on top of ${BASE_ENV.join(", ")}; the only file a run may write is ${SESSION_FILES.join(", ")}`,
  );

  if (command) {
    // The subcommand prints one document, and it must be about the directory
    // it was given: a validator pointed at some other tree says nothing of
    // this one.
    const document = run.trace.document();
    rule("document", document !== null, document ? "one JSON document" : "no JSON document", "one JSON document");
    const given = command.filter((word) => places[word]).map((word) => places[word]);
    if (document) {
      const inside = given.length === 1 && typeof document.target === "string" && document.target.startsWith(`${given[0]}/.claude-plugin/`);
      rule("target", inside, `target ${document.target}`, `a manifest under ${given[0]}/.claude-plugin/`);
    }
    return rules;
  }

  rule("init-present", init !== null, init ? "an init event" : "no init event", "an init event");
  rule("result-present", results.length > 0, results.length ? "a result event" : "no result event", "a result event");

  if (init) rule("cwd", Boolean(planned) && init.cwd === planned.cwd, `cwd ${init.cwd}`, planned ? `the working directory setup made for this run, ${planned.cwd}` : `a run setup planned, and it planned none named ${run.name}`);

  const mine = init?.plugins.filter((plugin) => plugin.name === "pstack") ?? [];
  if (init) rule("plugin-once", mine.length === 1, `${mine.length} plugins named pstack in init.plugins`, "exactly 1");
  if (mine.length) {
    const seen = (field) => mine.map((plugin) => plugin[field]).join(", ");
    rule("plugin-path", mine.every((plugin) => plugin.path === stage.plugin), `plugin path ${seen("path")}`, `the stage's plugin directory, ${stage.plugin}`);
    rule("plugin-source", mine.every((plugin) => plugin.source === "pstack@inline"), `plugin source ${seen("source")}`, "pstack@inline");
    rule("plugin-version", mine.every((plugin) => plugin.version === stage.version), `plugin version ${seen("version")}`, `the stage's VERSION, ${stage.version}`);
  }

  // Every surface check is a zero-model run.
  if (check.tier === "surface") {
    const models = run.trace.models();
    if (results.length) rule("zero-cost", results.every((result) => result.costUsd === 0), `total_cost_usd ${results.map((result) => result.costUsd).join(", ")}`, "total_cost_usd 0 on a zero-model run");
    rule("no-model", models.length === 0, models.length ? `model ${models.join(", ")}` : "no real model id", "no real model id on a zero-model run");
  }
  return rules;
}

// Defects worth a line even when the check passed, and what a reader needs
// to tell a failed plugin from a session that never ran. They change no
// verdict.
function observations(run, check) {
  const seen = [];
  if (run.ended.spawnError) seen.push(`the CLI did not start: ${run.ended.spawnError}`);
  if (run.ended.timedOut) seen.push("the driver stopped the session at its time limit");
  if (run.ended.stderr) seen.push(`the session wrote to stderr: ${run.ended.stderr}`);
  const hooks = run.trace.hooks();
  const starts = hooks.filter((hook) => hook.event === "SessionStart");
  // One per source: a session that is cleared starts again, with its own.
  for (const name of new Set(starts.map((hook) => hook.name))) {
    const same = starts.filter((hook) => hook.name === name).length;
    if (same > 1) seen.push(`${same} ${name} hook responses in one session`);
  }
  for (const hook of hooks) {
    if (hook.stderr) seen.push(`hook ${hook.name} wrote to stderr: ${hook.stderr.trim().split("\n")[0]}`);
  }
  for (const line of run.trace.transcriptLines()) {
    if (line.durationMs > SLOW_HOOK_MS) seen.push(`hook ${line.hookName} took ${line.durationMs} ms`);
  }
  const init = run.trace.init();
  if (init) {
    const extra = init.plugins.filter((plugin) => plugin.name !== "pstack" && !plugin.source?.endsWith("@builtin"));
    if (extra.length) seen.push(`plugins beside pstack and the built-ins: ${extra.map((plugin) => plugin.source).join(", ")}`);
    if (init.mcpServers.length) seen.push(`MCP servers in init: ${init.mcpServers.join(", ")}`);
    if (init.cliVersion !== PIN.verified) seen.push(`CLI ${init.cliVersion}; the checks were verified on ${PIN.verified}`);
  }
  if (run.trace.malformed && !check.commands?.[run.name]) seen.push(`${run.trace.malformed} stream lines are not JSON`);
  return seen.map((text) => ({ run: run.name, text }));
}

function judge(id, check, setup, stage, dir) {
  const recorded = (setup.checks ?? []).find((each) => each.id === id);
  const base = { id, title: check?.title ?? "(no check file)", tier: check?.tier ?? null, selected: setup.selected.includes(id) };
  // The run was judged by one set of check files. With one gone or changed,
  // a rerun would be another judge's verdict under the first one's name.
  if (!check) return { ...base, verdict: "error", reason: `no check file for ${id}${recorded ? `; the run was judged by ${recorded.file}` : ""}` };
  if (!base.selected) return { ...base, verdict: "skipped", reason: "not selected" };
  if (recorded?.sha256 !== check.sha256) {
    return { ...base, verdict: "error", reason: `${check.file} ${recorded ? "changed after the run" : "was not there at the run"}; ${RERUN}` };
  }
  if (setup.cli.problem) {
    return { ...base, verdict: setup.cli.missing && !setup.cli.required ? "skipped" : "error", reason: setup.cli.problem };
  }

  const runs = existsSync(dir) ? runNames(dir).map((name) => readRun(dir, name)) : [];
  const rules = runs.flatMap((run) => integrity(run, check, setup, stage));
  let assertions = [];
  // A check that asks for no trace must not pass because none was there.
  let reason = runs.length ? null : "every trace is missing";
  try {
    assertions = check.assertions({
      trace: (name) => runs.find((run) => run.name === name)?.trace ?? missing(`the ${name} trace`),
      stage: stage.offered,
      missing,
    });
  } catch (error) {
    if (!(error instanceof Missing)) return { ...base, verdict: "error", reason: error.stack ?? String(error) };
    reason = `${error.message} is missing`;
  }

  const failed = [...rules, ...assertions].filter((item) => !item.ok).map((item) => `${id}.${item.id}`);
  return {
    ...base,
    verdict: failed.length ? "fail" : reason ? "unobservable" : "pass",
    reason,
    failed,
    integrity: rules,
    assertions,
    observations: runs.flatMap((run) => observations(run, check)),
    cost_usd: runs.reduce((sum, run) => sum + (run.trace.result()?.costUsd ?? 0), 0),
  };
}

function tierSummary(tier, checks, cli) {
  const mine = checks.filter((check) => check.tier === tier);
  if (!mine.length) return `${tier} NOT BUILT`;
  if (!mine.some((check) => check.selected)) return `${tier} NOT RUN`;
  if (cli.problem) return `${tier}: ${cli.problem}`;
  return `${tier} ${mine.filter((check) => check.verdict === "pass").length}/${mine.length}`;
}

// PASS is kept for a run in which every check passed against the CLI a user
// has. Nothing failed in a STAND-IN run (another CLI was driven) or a PARTIAL
// one (some check was left out), and neither is a pass.
function word(checks, cli) {
  const passed = checks.filter((each) => each.verdict === "pass").length;
  if (checks.some((each) => FAILED.includes(each.verdict))) return "FAIL";
  if (!passed) return "SKIPPED";
  if (cli.stand_in) return "STAND-IN";
  return passed === checks.length ? "PASS" : "PARTIAL";
}

export async function check(evidenceDir, checksDir = CHECKS_DIR) {
  const setup = JSON.parse(readFileSync(join(evidenceDir, "setup.json"), "utf8"));
  const stage = readStage(setup);
  const files = await loadDir(checksDir);
  const traces = join(evidenceDir, "traces");
  const traced = existsSync(traces)
    ? readdirSync(traces, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  // Every check the run knew of is judged, with or without its file: a check
  // that is deleted must not drop out of the verdict with it.
  const ids = [...new Set([...files, ...(setup.checks ?? [])].map((each) => each.id).concat(setup.selected, traced))].sort();
  const checks = ids.map((id) => judge(id, files.find((each) => each.id === id), setup, stage, join(traces, id)));

  const verdict = word(checks, setup.cli);
  return {
    line: `${verdict} ${TIERS.map((tier) => tierSummary(tier, checks, setup.cli)).join(" | ")} | round ${setup.round}`,
    verdict,
    run: setup.run,
    round: setup.round,
    subject_id: setup.subject_id,
    tree_id: setup.tree_id,
    stage: setup.stage,
    stage_hash: setup.stage_hash,
    sandbox: setup.sandbox,
    selection: setup.selection,
    cli_version: setup.cli.version,
    cli_verified: PIN.verified,
    cli_path: setup.cli.real_path,
    cli_sha256: setup.cli.sha256,
    cli_stand_in: setup.cli.stand_in,
    cost_usd: checks.reduce((sum, each) => sum + (each.cost_usd ?? 0), 0),
    checks,
  };
}
