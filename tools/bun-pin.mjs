// The bun the port is built and tested with. CI is the single source: every
// setup-bun step in ci.yml names it, and tests/bun-pin.test.mjs keeps those
// copies equal, so a local run reads the pin instead of keeping a second one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { versionAtLeast } from "./pi-package.mjs";

const WORKFLOW = new URL("../.github/workflows/ci.yml", import.meta.url);

export function bunPins(workflow = readFileSync(WORKFLOW, "utf8")) {
  return [...workflow.matchAll(/^\s*bun-version:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

// Only major.minor has to match: bun 1.4.5 reads everything 1.4.4 does, and
// 1.3.x does not (it cannot parse plugins/bun.lock).
export function bunTooOld(installed, pinned) {
  const [major, minor] = pinned.split(".");
  return !versionAtLeast(installed, `${major}.${minor}.0`);
}

export function bunTooOldMessage(installed, pinned) {
  const file = fileURLToPath(WORKFLOW).replace(/^.*\.github/, ".github");
  return `This checkout needs bun ${pinned} or newer (pinned in ${file}). You have bun ${installed}. Older bun cannot parse plugins/bun.lock, so tests fail with errors that do not say why. Run:\n  bun upgrade`;
}
