// Setup, the first of the verifier's three roles: it decides what is under
// test and where it runs. It snapshots the tree that would be committed,
// extracts the product paths into a stage outside the working tree, and
// builds each session a throwaway home, config directory and working
// directory with an environment made from an allow-list. It starts git, tar
// and `claude --version`; it never starts a session.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { PRODUCT, WATCHED } from "./paths.mjs";
import { sha256, stageHash, stageSeal } from "./stage.mjs";

const PIN = JSON.parse(readFileSync(new URL("./cli-pin.json", import.meta.url), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 1 << 28, ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${String(result.stderr).trim()}`);
  return result.stdout;
}

// The variables that tell git which repository to act on, as git lists them.
// A git hook in a linked worktree runs with GIT_DIR exported, and with it
// `git -C <elsewhere>` still acts on the hook's repository.
let locating;
export function gitEnv(env = process.env) {
  locating ??= new Set(run("git", ["rev-parse", "--local-env-vars"]).toString().split("\n"));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !locating.has(name)));
}

const gitBytes = (root, args, env = {}) => run("git", ["-C", root, ...args], { env: { ...gitEnv(), ...env } });
const git = (root, args, env) => gitBytes(root, args, env).toString();

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

export function buildStage({ root, treeId }, dir) {
  const present = git(root, ["ls-tree", "--name-only", treeId, "--", ...PRODUCT]).split("\n").filter(Boolean);
  // With no path, git archive would export the whole tree.
  if (!present.length) throw new Error(`${root} holds none of ${PRODUCT.join(", ")}`);
  mkdirSync(dir, { recursive: true });
  run("tar", ["-x", "-f", "-", "-C", dir], { input: gitBytes(root, ["archive", "--format=tar", treeId, "--", ...present]) });
  // The CLI reports the plugin path it was given, and the checker compares
  // that with this one, so a symlinked directory is resolved first.
  const stage = realpathSync(dir);
  return { stage, stageHash: stageHash(stage), stageSeal: stageSeal(stage) };
}

// Where one verifier run keeps its sessions' directories. They are thrown
// away after the drive, so they stay out of the evidence. Resolved, because
// a session reports its working directory resolved.
export const sandboxBase = () => realpathSync(mkdtempSync(join(tmpdir(), "pstack-verify-")));

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

// In pieces: the CLI is a few hundred megabytes.
function fileSha256(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const piece = Buffer.alloc(1 << 22);
    for (let read = readSync(fd, piece); read > 0; read = readSync(fd, piece)) hash.update(piece.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// `problem` is null when the CLI can be driven. `stand_in` says why a run
// against this CLI is no verdict on the one a user has: it was named through
// the environment, or it does not call itself Claude Code. The checker turns
// both into verdicts; setup only records what it found.
export function doctor(box, env = process.env, pin = PIN) {
  const required = env.PSTACK_VERIFY_REQUIRE_CLI === "1";
  const named = Boolean(env.PSTACK_VERIFY_CLAUDE);
  const found = { path: findCli(env), real_path: null, sha256: null, version: null, stand_in: null, missing: false, required };
  // A name that leads nowhere is a mistake to report, not a machine without the CLI.
  if (!found.path) return named ? { ...found, problem: "PSTACK_VERIFY_CLAUDE does not name an executable" } : { ...found, missing: true, problem: "claude is not on PATH" };

  const real = realpathSync(found.path);
  const probe = spawnSync(found.path, ["--version"], { env: childEnv(box, env), encoding: "utf8", timeout: 30_000 });
  const banner = (probe.stdout ?? "").split("\n").find((line) => /\d+\.\d+\.\d+/.test(line))?.trim() ?? "";
  const version = banner.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  const problem = !version
    ? "claude --version printed no version"
    : olderThan(version, pin.minimum)
      ? `claude ${version} is older than the minimum ${pin.minimum}`
      : null;
  const standIn = named ? "named by PSTACK_VERIFY_CLAUDE" : banner === `${version} (Claude Code)` ? null : `calls itself ${JSON.stringify(banner)}`;
  return { ...found, real_path: real, sha256: fileSha256(real), version, stand_in: standIn, problem };
}
