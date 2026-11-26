#!/usr/bin/env bun
// Verifies the plugin the way a Claude Code user meets it, in three roles
// kept in three modules so that none can vouch for itself:
//
//   setup  (verify/setup.mjs)  snapshots the tree that would be committed
//                              into a stage and builds a clean environment
//   driver (verify/drive.mjs)  starts the real `claude` CLI against the stage
//                              and saves raw traces
//   checker (verify/check.mjs) recomputes every verdict from those traces
//
//   bun tools/verify.mjs [--tier surface|behavior|all] [--flow <id>]
//                        [--tree <checkout>] [--evidence <dir>] [--jobs 1-3]
//   bun tools/verify.mjs check <evidence-dir>
//
// One file per check: verify/flows/<id>-<name>.mjs says what to run and
// verify/checks/<id>-<name>.mjs says what must hold. Evidence goes to
// <git dir>/pstack-verify/runs/<run>/, the last five runs are kept, and
// `check` reruns the checker alone on a run directory or on the newest run of
// an evidence root. Exit 1 on any fail, unobservable or error.
//
// PSTACK_VERIFY_CLAUDE names the CLI to drive instead of `claude` on PATH.
// With no CLI the run is SKIPPED and exits 0, or exits 1 when
// PSTACK_VERIFY_REQUIRE_CLI=1.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./plugin.mjs";
import { check, TIERS } from "./verify/check.mjs";
import { drive } from "./verify/drive.mjs";
import { nextRound, prune, recordRound, writeEvidence } from "./verify/evidence.mjs";
import { CHECKS_DIR, FLOWS_DIR, loadDir, PLUGIN_IN_STAGE } from "./verify/paths.mjs";
import { buildStage, discardSandboxes, doctor, evidenceRoot, plan, sandbox, sandboxRoot, snapshot } from "./verify/setup.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: bun tools/verify.mjs [--tier ${TIERS.join("|")}|all] [--flow <id>] [--tree <checkout>] [--evidence <dir>] [--jobs 1-3]
       bun tools/verify.mjs check <evidence-dir>`;

class UsageError extends Error {}

function parse(args) {
  const options = { tier: "all", flow: null, tree: repo, evidence: null, jobs: 2 };
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !Object.hasOwn(options, name) || args[i + 1] === undefined) throw new UsageError(USAGE);
    options[name] = args[i + 1];
  }
  options.jobs = Number(options.jobs);
  if (![...TIERS, "all"].includes(options.tier) || ![1, 2, 3].includes(options.jobs)) throw new UsageError(USAGE);
  return options;
}

// A flow with no check would be driven and never judged, and a check with no
// flow would never run, so the two directories must list the same checks.
async function loadFlows() {
  const flows = await loadDir(FLOWS_DIR);
  const checks = await loadDir(CHECKS_DIR);
  const pairs = (list) => list.map((each) => `${each.file}:${each.tier}`).join(" ");
  if (pairs(flows) !== pairs(checks)) throw new Error(`flows/ and checks/ disagree: flows [${pairs(flows)}], checks [${pairs(checks)}]`);
  return flows;
}

async function report(dir) {
  const result = await check(dir);
  console.log(writeEvidence(dir, result));
  console.log(`evidence: ${dir}`);
  return result;
}

async function verify(options) {
  const flows = await loadFlows();
  if (options.flow && !flows.some((flow) => flow.id === options.flow)) {
    throw new UsageError(`no flow ${options.flow}; flows: ${flows.map((flow) => flow.id).join(", ")}`);
  }
  const selected = flows.filter((flow) => ["all", flow.tier].includes(options.tier) && [null, flow.id].includes(options.flow));

  const snap = snapshot(options.tree);
  const root = resolve(options.evidence ?? evidenceRoot(snap.root));
  const run = `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
  const dir = join(root, "runs", run);
  const base = join(sandboxRoot(root), run);
  const { stage, stageHash } = buildStage(snap, join(base, "stage"));
  const cli = doctor(sandbox(join(base, "doctor")));

  mkdirSync(dir, { recursive: true });
  const setup = {
    run,
    round: nextRound(root),
    subject_id: snap.subjectId,
    stage,
    stage_hash: stageHash,
    cli,
    selection: { tier: options.tier, flow: options.flow },
    selected: selected.map((flow) => flow.id),
  };
  writeFileSync(join(dir, "setup.json"), `${JSON.stringify(setup, null, 2)}\n`);

  if (!cli.problem) {
    await drive(plan(selected, base), { cli: cli.path, plugin: join(stage, PLUGIN_IN_STAGE), out: join(dir, "traces"), jobs: options.jobs });
  }
  discardSandboxes(base);

  const result = await report(dir);
  recordRound(root, result);
  prune(root, sandboxRoot(root));
  return result;
}

function runDirectory(given) {
  const dir = resolve(given);
  if (existsSync(join(dir, "setup.json"))) return dir;
  const runs = existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")).sort() : [];
  if (!runs.length) throw new UsageError(`${given} is neither a run directory nor an evidence root with runs`);
  return join(dir, "runs", runs.at(-1));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "check" && args.length !== 2) throw new UsageError(USAGE);
  const result = args[0] === "check" ? await report(runDirectory(args[1])) : await verify(parse(args));
  if (result.verdict === "FAIL") process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof UsageError ? err.message : `FAIL: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
