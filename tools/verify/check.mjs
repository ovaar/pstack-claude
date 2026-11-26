// The checker, the third role: a pure function from an evidence directory to
// verdicts. It starts no process and reads traces only through trace.mjs.
// Every verdict is recomputed from structured events, never from what a model
// wrote and never from an exit code. Before a check's own assertions count,
// the integrity rules confirm the driver ran what it was meant to run: the
// plugin came from the stage, the stage did not move, the trace is the one
// the driver hashed, and a zero-model run called no model.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CHECKS_DIR, loadDir, PLUGIN_IN_STAGE } from "./paths.mjs";
import { sha256, stageHash } from "./stage.mjs";
import { readRun, runNames } from "./trace.mjs";

const PIN = JSON.parse(readFileSync(new URL("./cli-pin.json", import.meta.url), "utf8"));

export const TIERS = ["surface", "behavior"];
const FAILED = ["fail", "unobservable", "error"];
const BANNED_FLAGS = ["--bare", "--safe-mode"];
const SLOW_HOOK_MS = 1000;

// Thrown when a record a check needs is not in the evidence. The check is
// then unobservable, which counts as failed: no verdict rests on an absence.
class Missing extends Error {}
const missing = (what) => {
  throw new Missing(what);
};

function readStage(setup) {
  const read = (path) => {
    try {
      return readFileSync(join(setup.stage, path));
    } catch {
      return null;
    }
  };
  return {
    plugin: join(setup.stage, PLUGIN_IN_STAGE),
    recorded: setup.stage_hash,
    hash: stageHash(setup.stage),
    version: read("VERSION")?.toString("utf8").trim() ?? null,
    sha256: (path) => {
      const bytes = read(path);
      return bytes && sha256(bytes);
    },
  };
}

// A rule that cannot be evaluated is left out, not failed: a trace with no
// init fails `init-present` once instead of dragging four plugin rules along.
function integrity(run, stage, zeroModel) {
  const rules = [];
  const rule = (id, ok, saw, want) => rules.push({ id: `${run.name}.${id}`, ok, saw, want });
  const init = run.trace.init();
  const results = run.trace.results();
  const banned = run.argv.filter((arg) => BANNED_FLAGS.includes(arg));

  rule("stage-hash", stage.hash !== null && stage.hash === stage.recorded, stage.hash === null ? "the stage is gone" : `stage hash ${stage.hash}`, `the stage hash setup recorded, ${stage.recorded}`);
  rule("trace-sha256", run.sha256 === run.recordedSha256, `trace sha256 ${run.sha256}`, `the sha256 in the sidecar, ${run.recordedSha256}`);
  rule("argv", banned.length === 0, banned.length ? `argv with ${banned.join(" ")}` : `argv without ${BANNED_FLAGS.join(" or ")}`, `no ${BANNED_FLAGS.join(" or ")}`);
  rule("init-present", init !== null, init ? "an init event" : "no init event", "an init event");
  rule("result-present", results.length > 0, results.length ? "a result event" : "no result event", "a result event");

  const mine = init?.plugins.filter((plugin) => plugin.name === "pstack") ?? [];
  if (init) rule("plugin-once", mine.length === 1, `${mine.length} plugins named pstack in init.plugins`, "exactly 1");
  if (mine.length) {
    const seen = (field) => mine.map((plugin) => plugin[field]).join(", ");
    rule("plugin-path", mine.every((plugin) => plugin.path === stage.plugin), `plugin path ${seen("path")}`, `the stage's plugin directory, ${stage.plugin}`);
    rule("plugin-source", mine.every((plugin) => plugin.source === "pstack@inline"), `plugin source ${seen("source")}`, "pstack@inline");
    rule("plugin-version", mine.every((plugin) => plugin.version === stage.version), `plugin version ${seen("version")}`, `the stage's VERSION, ${stage.version}`);
  }

  if (zeroModel) {
    const models = run.trace.models();
    if (results.length) rule("zero-cost", results.every((result) => result.costUsd === 0), `total_cost_usd ${results.map((result) => result.costUsd).join(", ")}`, "total_cost_usd 0 on a zero-model run");
    rule("no-model", models.length === 0, models.length ? `model ${models.join(", ")}` : "no real model id", "no real model id on a zero-model run");
  }
  return rules;
}

// Defects worth a line even when the check passed. They change no verdict.
function observations(run) {
  const seen = [];
  const hooks = run.trace.hooks();
  const starts = hooks.filter((hook) => hook.event === "SessionStart");
  if (starts.length > 1) seen.push(`${starts.length} SessionStart hook responses in one session`);
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
  if (run.trace.malformed) seen.push(`${run.trace.malformed} stream lines are not JSON`);
  return seen.map((text) => ({ run: run.name, text }));
}

function judge(check, setup, stage, dir) {
  const base = { id: check.id, title: check.title, tier: check.tier, selected: setup.selected.includes(check.id) };
  if (!base.selected) return { ...base, verdict: "skipped", reason: "not selected" };
  if (setup.cli.problem) {
    return { ...base, verdict: setup.cli.missing && !setup.cli.required ? "skipped" : "error", reason: setup.cli.problem };
  }

  const runs = existsSync(dir) ? runNames(dir).map((name) => readRun(dir, name)) : [];
  const rules = runs.flatMap((run) => integrity(run, stage, check.tier === "surface"));
  let assertions = [];
  let reason = null;
  try {
    assertions = check.assertions({
      trace: (name) => runs.find((run) => run.name === name)?.trace ?? missing(`the ${name} trace`),
      stage: { sha256: stage.sha256 },
      missing,
    });
  } catch (error) {
    if (!(error instanceof Missing)) return { ...base, verdict: "error", reason: error.stack ?? String(error) };
    reason = `${error.message} is missing`;
  }

  const failed = [...rules, ...assertions].filter((item) => !item.ok).map((item) => `${check.id}.${item.id}`);
  return {
    ...base,
    verdict: failed.length ? "fail" : reason ? "unobservable" : "pass",
    reason,
    failed,
    integrity: rules,
    assertions,
    observations: runs.flatMap(observations),
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

export async function check(evidenceDir, checksDir = CHECKS_DIR) {
  const setup = JSON.parse(readFileSync(join(evidenceDir, "setup.json"), "utf8"));
  const stage = readStage(setup);
  const checks = (await loadDir(checksDir)).map((each) => judge(each, setup, stage, join(evidenceDir, "traces", each.id)));

  // The word leads the line, but a receipt is read check by check: a run
  // limited to one flow passes here with the other checks marked skipped.
  const verdict = checks.some((each) => FAILED.includes(each.verdict)) ? "FAIL" : checks.some((each) => each.verdict === "pass") ? "PASS" : "SKIPPED";
  return {
    line: `${verdict} ${TIERS.map((tier) => tierSummary(tier, checks, setup.cli)).join(" | ")} | round ${setup.round}`,
    verdict,
    run: setup.run,
    round: setup.round,
    subject_id: setup.subject_id,
    stage: setup.stage,
    stage_hash: setup.stage_hash,
    selection: setup.selection,
    cli_version: setup.cli.version,
    cli_verified: PIN.verified,
    cost_usd: checks.reduce((sum, each) => sum + (each.cost_usd ?? 0), 0),
    checks,
  };
}
