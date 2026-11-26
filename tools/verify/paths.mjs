// The path sets the verifier loop is built on, and the two directories it
// discovers its checks from. One file per check in each directory, so a new
// check is a new pair of files and no shared table has to change.

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// What a Claude Code user loads. Only these paths are copied into the stage.
export const PRODUCT = ["plugins/pstack", ".claude-plugin", "VERSION"];
// What decides a verdict. A change here changes what PASS means.
export const JUDGE = [
  "tools/verify.mjs",
  "tools/verify",
  "tests/verify",
  ".claude/settings.json",
  ".github/workflows/behavior.yml",
  ".github/workflows/behavior-nightly.yml",
];
// What tells an agent to run the loop.
export const STEERING = [".claude/skills/verify", ".agents/playbooks"];
export const WATCHED = [...PRODUCT, ...JUDGE, ...STEERING];

export const PLUGIN_IN_STAGE = "plugins/pstack";

const here = dirname(fileURLToPath(import.meta.url));
export const FLOWS_DIR = join(here, "flows");
export const CHECKS_DIR = join(here, "checks");

// `S2-loads-from-tree.mjs` is check S2. The id is what a receipt records.
export const idOf = (file) => basename(file, ".mjs").split("-")[0];

export async function loadDir(dir) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".mjs"))
    .sort();
  const loaded = [];
  for (const file of files) {
    const id = idOf(file);
    if (loaded.some((entry) => entry.id === id)) throw new Error(`${dir} holds two files for ${id}`);
    loaded.push({ id, file, ...(await import(pathToFileURL(join(dir, file)).href)) });
  }
  return loaded;
}
