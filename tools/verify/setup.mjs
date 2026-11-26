// Setup, the first of the verifier's three roles: it decides what is under
// test and where it runs. It snapshots the tree that would be committed,
// extracts the product paths into a stage outside the repository, and builds
// each session a throwaway home, config directory and working directory with
// an environment made from an allow-list. It starts git, tar and
// `claude --version`; it never starts a session.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { PRODUCT, WATCHED } from "./paths.mjs";
import { sha256, stageHash } from "./stage.mjs";

const PIN = JSON.parse(readFileSync(new URL("./cli-pin.json", import.meta.url), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 1 << 28, ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${String(result.stderr).trim()}`);
  return result.stdout;
}

const git = (root, args, env = {}) => run("git", ["-C", root, ...args], { env: { ...process.env, ...env } }).toString();

// The tree a commit made now would hold: HEAD plus every changed and
// untracked file. A temporary index builds it, so the real index and the
// working tree are left as they were.
export function snapshot(tree) {
  const root = git(tree, ["rev-parse", "--show-toplevel"]).trim();
  const scratch = mkdtempSync(join(tmpdir(), "pstack-verify-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(root, ["read-tree", "HEAD"], env);
    git(root, ["add", "-A"], env);
    const treeId = git(root, ["write-tree"], env).trim();
    return { root, treeId, subjectId: sha256(git(root, ["ls-tree", treeId, "--", ...WATCHED])) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Evidence lives in the git directory: in the working tree the Markdown lint
// and the link check would scan it, and it would show in `git status`.
export const evidenceRoot = (root) => join(git(root, ["rev-parse", "--absolute-git-dir"]).trim(), "pstack-verify");

// Stages and sandboxes of one evidence root share one directory, so pruning
// lists that directory and never deletes a path it read from a file.
export const sandboxRoot = (evidence) => join(realpathSync(tmpdir()), `pstack-verify-${sha256(evidence).slice(0, 12)}`);

export function buildStage({ root, treeId }, dir) {
  const present = git(root, ["ls-tree", "--name-only", treeId, "--", ...PRODUCT]).split("\n").filter(Boolean);
  // With no path, git archive would export the whole tree.
  if (!present.length) throw new Error(`${root} holds none of ${PRODUCT.join(", ")}`);
  mkdirSync(dir, { recursive: true });
  run("tar", ["-x", "-f", "-", "-C", dir], { input: run("git", ["-C", root, "archive", "--format=tar", treeId, "--", ...present]) });
  // The CLI reports the plugin path it was given, and the checker compares
  // that with this one, so a symlinked temp directory is resolved first.
  const stage = realpathSync(dir);
  return { stage, stageHash: stageHash(stage) };
}

export function sandbox(dir) {
  const box = { home: join(dir, "home"), config: join(dir, "config"), cwd: join(dir, "cwd") };
  for (const path of Object.values(box)) mkdirSync(path, { recursive: true });
  return box;
}

// Named variables only. A deny-list would miss the next CLAUDE_CODE_* or
// plugin-root variable a parent session exports, and one of those reaching a
// run changes which sheet the hook reads or signs the run in.
const INHERITED = ["PATH", "TMPDIR", "LANG"];

export function childEnv(box, env = process.env) {
  const inherited = INHERITED.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]);
  return { ...Object.fromEntries(inherited), HOME: box.home, CLAUDE_CONFIG_DIR: box.config };
}

// One sandbox per run: two runs at once never share a config directory.
export function plan(flows, base, env = process.env) {
  return flows.flatMap((flow) =>
    flow.runs.map((session) => {
      const box = sandbox(join(base, flow.id, session.name));
      return { id: flow.id, ...session, cwd: box.cwd, config: box.config, env: childEnv(box, env) };
    }),
  );
}

// The stage stays for as long as its evidence does, so the checker can be
// rerun against it. Everything else under the run's directory is throwaway.
export function discardSandboxes(base) {
  for (const name of readdirSync(base)) {
    if (name !== "stage") rmSync(join(base, name), { recursive: true, force: true });
  }
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findCli(env = process.env) {
  if (env.PSTACK_VERIFY_CLAUDE) return executable(env.PSTACK_VERIFY_CLAUDE) ? env.PSTACK_VERIFY_CLAUDE : null;
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "claude"))
    .find(executable) ?? null;
}

export function olderThan(version, floor) {
  const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
  const at = a.findIndex((part, i) => part !== b[i]);
  return at !== -1 && a[at] < b[at];
}

// `problem` is null when the CLI can be driven. The checker turns a problem
// into verdicts; setup only records what it found.
export function doctor(box, env = process.env, pin = PIN) {
  const required = env.PSTACK_VERIFY_REQUIRE_CLI === "1";
  const path = findCli(env);
  if (!path) {
    const problem = env.PSTACK_VERIFY_CLAUDE ? "PSTACK_VERIFY_CLAUDE does not name an executable" : "claude is not on PATH";
    return { path, version: null, missing: true, required, problem };
  }
  const probe = spawnSync(path, ["--version"], { env: childEnv(box, env), encoding: "utf8", timeout: 30_000 });
  const version = probe.stdout?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  const problem = !version
    ? "claude --version printed no version"
    : olderThan(version, pin.minimum)
      ? `claude ${version} is older than the minimum ${pin.minimum}`
      : null;
  return { path, version, missing: false, required, problem };
}
