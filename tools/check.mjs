// Runs the CI checks that need only bun and this repo, then each external
// linter that is installed, and prints one verdict. A check that cannot run
// is SKIPPED with its reason and never counts as passed. Commands are copied
// from .github/workflows/ci.yml and CONTRIBUTING.md; change them together.
//
//   bun tools/check.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bunPins, bunTooOld, bunTooOldMessage } from "./bun-pin.mjs";
import { findPiPackage } from "./pi-package.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const scripts = "plugins/pstack/skills/poteto-mode/scripts";

// Each step: a name, an argv, an optional cwd, an optional `needs` binary that
// must be on PATH, and an optional `skip` that returns a reason or null.
export function steps() {
  const upstream = JSON.parse(readFileSync(new URL("./upstream.json", import.meta.url), "utf8"));
  const forkDryRuns = Object.entries(upstream.components).map(([name, { sha }]) => ({
    name: `fork dry-run ${name}`,
    argv: ["bun", "tools/sync.mjs", name, sha, "--dry-run"],
  }));
  return [
    { name: "generate --check", argv: ["bun", "tools/generate.mjs", "--check"] },
    { name: "bun test", argv: ["bun", "test", "tests/"] },
    ...forkDryRuns,
    { name: "sync --check-rules", argv: ["bun", "tools/sync.mjs", "--check-rules"] },
    { name: "scripts: install", argv: ["bun", "install", "--frozen-lockfile"], cwd: scripts },
    { name: "scripts: typecheck", argv: ["bun", "run", "typecheck"], cwd: scripts },
    { name: "scripts: test", argv: ["bun", "test", "watch-pr"], cwd: scripts },
    { name: "scripts: prettier", argv: ["bunx", "prettier@3.6.2", "--check", "."], cwd: scripts },
    {
      name: "typecheck-pi",
      argv: ["bun", "tools/typecheck-pi.mjs"],
      skip: () => (findPiPackage() ? null : "no Pi package installed (set PI_PACKAGE_DIR or npm install -g @earendil-works/pi-coding-agent)"),
    },
    { name: "markdownlint", needs: "npx", argv: ["npx", "--yes", "markdownlint-cli2@0.18.1", "**/*.md"] },
    {
      name: "shellcheck",
      needs: "shellcheck",
      argv: [
        "sh",
        "-c",
        "find . -path ./.git -prune -o -path '*/node_modules' -prune -o -name '*.sh' -print | sed 's#^\\./##' | sort | xargs shellcheck --severity=warning",
      ],
    },
    { name: "actionlint", needs: "actionlint", argv: ["actionlint", "-no-color"] },
    {
      name: "lychee",
      needs: "lychee",
      argv: ["lychee", "--offline", "--no-progress", "--include-fragments", "--exclude-path", "node_modules", "--exclude-path", ".git", "**/*.md"],
    },
    // uvx, not zizmor itself, so the version stays the one CI pins.
    { name: "zizmor", needs: "uvx", argv: ["uvx", "zizmor@1.29.0", "--persona", "pedantic", "--min-severity", "low", "--collect", "all", "--", "."] },
  ];
}

const defaultExec = (step) => spawnSync(step.argv[0], step.argv.slice(1), { cwd: step.cwd ? `${repo}/${step.cwd}` : repo, stdio: "inherit" });

export function runSteps(list, { which = Bun.which, exec = defaultExec, log = console.log } = {}) {
  return list.map((step) => {
    const reason = step.skip?.() ?? (step.needs && !which(step.needs) ? `${step.needs} is not on PATH` : null);
    if (reason) {
      log(`\nSKIPPED ${step.name}: ${reason}`);
      return { name: step.name, status: "skipped", reason };
    }
    log(`\n== ${step.name}`);
    const { status, error } = exec(step);
    if (error) log(`could not run ${step.argv[0]}: ${error.message}`);
    return { name: step.name, status: status === 0 && !error ? "passed" : "failed" };
  });
}

export function summary(results) {
  const named = (status) => results.filter((r) => r.status === status).map((r) => (r.reason ? `${r.name} (${r.reason})` : r.name));
  const part = (label, items) => `${label} ${items.length}${items.length ? ` [${items.join("; ")}]` : ""}`;
  return [part("passed", named("passed")), part("failed", named("failed")), part("skipped", named("skipped"))].join(" | ");
}

export const exitCode = (results) => (results.some((r) => r.status === "failed") ? 1 : 0);

if (import.meta.main) {
  const [pinned] = bunPins();
  if (pinned && bunTooOld(Bun.version, pinned)) {
    console.error(bunTooOldMessage(Bun.version, pinned));
    process.exit(1);
  }
  const results = runSteps(steps());
  console.log(`\n${summary(results)}`);
  process.exit(exitCode(results));
}
