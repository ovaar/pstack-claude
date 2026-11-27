// The path sets the verifier loop is built on, and the two directories it
// discovers its checks from. One file per check in each directory, so a new
// check is a new pair of files and no shared table has to change.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PLUGIN } from "../plugin.mjs";
import { sha256 } from "./stage.mjs";

// What a Claude Code user loads. Only these paths are copied into the stage.
export const PRODUCT = [PLUGIN, ".claude-plugin", "VERSION"];
// What decides a verdict. A change here changes what PASS means.
export const JUDGE = [
  "tools/verify.mjs",
  "tools/verify",
  "tools/honesty.mjs",
  "tests/verify",
  ".claude/settings.json",
  ".github/workflows/behavior.yml",
  ".github/workflows/behavior-nightly.yml",
];
// What tells an agent to run the loop.
export const STEERING = [".claude/skills/verify", ".agents/playbooks"];
export const WATCHED = [...PRODUCT, ...JUDGE, ...STEERING];

const here = dirname(fileURLToPath(import.meta.url));
export const FLOWS_DIR = join(here, "flows");
export const CHECKS_DIR = join(here, "checks");

// `S2-loads-from-tree.mjs` is check S2. The id is what a receipt records.
export const idOf = (file) => basename(file, ".mjs").split("-")[0];

// Each file with its digest. Setup records the check files a run was judged
// by, and a rerun of the checker refuses to judge by any other.
export function listDir(dir) {
  const listed = readdirSync(dir)
    .filter((file) => file.endsWith(".mjs"))
    .sort()
    .map((file) => ({ id: idOf(file), file, sha256: sha256(readFileSync(join(dir, file))) }));
  const twice = listed.find((entry, at) => listed.findIndex((other) => other.id === entry.id) !== at);
  if (twice) throw new Error(`${dir} holds two files for ${twice.id}`);
  return listed;
}

export const loadDir = (dir) => Promise.all(listDir(dir).map(async (entry) => ({ ...entry, ...(await import(pathToFileURL(join(dir, entry.file)).href)) })));

// What a flow and its check must agree on: the file name, the tier, and the
// arguments of every run. The flow says what the driver starts and the check
// says what the checker accepts, so one edited alone is caught.
export const flowShape = (flow) => [flow.file, flow.tier, flow.runs.map((run) => [run.name, run.args ?? []]).sort()];
export const checkShape = (check) => [check.file, check.tier, Object.entries(check.args ?? {}).sort()];
