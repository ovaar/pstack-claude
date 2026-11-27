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
//   bun tools/verify.mjs honesty [--mutant <id>] [--keep] [--base <ref>]
//
// One file per check: verify/flows/<id>-<name>.mjs says what to run and
// verify/checks/<id>-<name>.mjs says what must hold. Evidence goes to
// <git dir>/pstack-verify/runs/<run>/ with the run's stage beside it, and the
// last five runs are kept. `check` reruns the checker alone on a run
// directory, or on the newest run of an evidence root. Its line starts with
// RECHECK and it writes *.recheck.* files beside the run's own: the receipt
// of a run is written once, by the run.
//
// The first line printed is the verdict. PASS: every check passed against
// the `claude` on PATH. PARTIAL: nothing failed, and --tier or --flow left a
// check out. STAND-IN: nothing failed against a CLI named by
// PSTACK_VERIFY_CLAUDE, or one that does not call itself Claude Code.
// SKIPPED: no CLI, nothing ran. FAIL: a check failed, was unobservable or
// could not be judged. Exit 1 on FAIL, which a missing CLI is when
// PSTACK_VERIFY_REQUIRE_CLI=1.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, PLUGIN } from "./plugin.mjs";
import { check, TIERS } from "./verify/check.mjs";
import { drive } from "./verify/drive.mjs";
import { nextRound, prune, recordRound, writeEvidence } from "./verify/evidence.mjs";
import { CHECKS_DIR, checkShape, FLOWS_DIR, flowShape, loadDir } from "./verify/paths.mjs";
import { buildStage, doctor, evidenceRoot, plan, sandbox, sandboxBase, snapshot } from "./verify/setup.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: bun tools/verify.mjs [--tier ${TIERS.join("|")}|all] [--flow <id>] [--tree <checkout>] [--evidence <dir>] [--jobs 1-3]
       bun tools/verify.mjs check <evidence-dir>
       bun tools/verify.mjs honesty [--mutant <id>] [--keep] [--base <ref>]`;

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

// A flow with no check would be driven and never judged, a check with no
// flow would never run, and a flow whose arguments its check does not
// declare would only fail later, so the two directories must agree.
async function loadPairs() {
  const flows = await loadDir(FLOWS_DIR);
  const checks = await loadDir(CHECKS_DIR);
  const [fromFlows, fromChecks] = [flows.map(flowShape), checks.map(checkShape)].map((shapes) => JSON.stringify(shapes));
  if (fromFlows !== fromChecks) throw new Error(`flows/ and checks/ disagree: flows ${fromFlows}, checks ${fromChecks}`);
  return { flows, checks };
}

// A rerun of the checker judges whatever the run directory holds now, which
// may no longer be what the run left, so its line says what it is.
async function report(dir, recheckedAt) {
  const judged = await check(dir);
  const result = recheckedAt ? { ...judged, line: `RECHECK ${judged.line}`, rechecked_at: recheckedAt } : judged;
  console.log(writeEvidence(dir, result));
  console.log(`evidence: ${dir}`);
  return result;
}

async function verify(options) {
  const { flows, checks } = await loadPairs();
  if (options.flow && !flows.some((flow) => flow.id === options.flow)) {
    throw new UsageError(`no flow ${options.flow}; flows: ${flows.map((flow) => flow.id).join(", ")}`);
  }
  const selected = flows.filter((flow) => ["all", flow.tier].includes(options.tier) && [null, flow.id].includes(options.flow));

  const snap = snapshot(options.tree);
  const root = resolve(options.evidence ?? evidenceRoot(snap.root));
  const run = `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
  const dir = join(root, "runs", run);
  // Made before the stage: a run that ends meanwhile prunes the oldest run
  // directories, and this one has to be among those it counts.
  mkdirSync(dir, { recursive: true });
  const base = sandboxBase();
  try {
    const { stage, stageHash, stageSeal } = buildStage(snap, join(dir, "stage"));
    const cli = doctor(sandbox(join(base, "doctor")));
    const sessions = cli.problem ? [] : plan(selected, base);
    const setup = {
      run,
      round: nextRound(root),
      subject_id: snap.subjectId,
      tree_id: snap.treeId,
      stage,
      stage_hash: stageHash,
      stage_seal: stageSeal,
      sandbox: base,
      cli,
      selection: { tier: options.tier, flow: options.flow },
      selected: selected.map((flow) => flow.id),
      checks: checks.map(({ id, file, sha256 }) => ({ id, file, sha256 })),
      sessions: sessions.map(({ id, name, cwd }) => ({ check: id, name, cwd })),
    };
    writeFileSync(join(dir, "setup.json"), `${JSON.stringify(setup, null, 2)}\n`);
    await drive(sessions, { cli: cli.path, plugin: join(stage, PLUGIN), out: join(dir, "traces"), jobs: options.jobs });
  } catch (err) {
    // A run that stopped before its setup record leaves nothing to check.
    if (!existsSync(join(dir, "setup.json"))) rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const result = await report(dir);
  const dropped = recordRound(root, result);
  if (dropped.length) console.log(`the round count stands: this pass held no check ${dropped.join(", ")}, which a failed round did`);
  prune(root);
  return result;
}

function runDirectory(given) {
  const dir = resolve(given);
  if (existsSync(join(dir, "setup.json"))) return dir;
  const runs = existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")).filter((run) => existsSync(join(dir, "runs", run, "setup.json"))).sort() : [];
  if (!runs.length) throw new UsageError(`${given} is neither a run directory nor an evidence root with runs`);
  return join(dir, "runs", runs.at(-1));
}

async function main() {
  const args = process.argv.slice(2);
  // Plants known mistakes and runs this verifier on each; see honesty.mjs.
  if (args[0] === "honesty") {
    const { main: honesty } = await import("./honesty.mjs");
    process.exit(honesty(args.slice(1)));
  }
  if (args[0] === "check" && args.length !== 2) throw new UsageError(USAGE);
  const result = args[0] === "check" ? await report(runDirectory(args[1]), new Date().toISOString()) : await verify(parse(args));
  if (result.verdict === "FAIL") process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof UsageError ? err.message : `FAIL: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
