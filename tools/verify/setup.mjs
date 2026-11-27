// Setup, the first of the verifier's three roles: it decides what is under
// test and where it runs. It snapshots the tree that would be committed,
// extracts the product paths into a stage outside the working tree, and
// builds each session a throwaway home, config directory and working
// directory with an environment made from an allow-list. It starts git, tar
// and `claude --version`; it never starts a session.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import { SKILLS } from "../plugin.mjs";
import { BUDGET_USD, MAX_MODEL_CALLS, PRODUCT, WATCHED } from "./paths.mjs";
import { SESSION_FILES, sha256, stageHash, stageSeal } from "./stage.mjs";

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

// Credentials are handed on by name and only to the sessions that call a
// model. Where neither is set, a session signs in as the person who runs the
// verifier: their own home and config directory, and on macOS the USER the
// keychain entry is filed under. Nothing else of the environment comes along.
export const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const LOGIN = ["USER"];

function localEnv(env, box) {
  const inherited = [...INHERITED, ...LOGIN, ...(env.CLAUDE_CONFIG_DIR ? ["CLAUDE_CONFIG_DIR"] : [])].filter((name) => env[name] !== undefined).map((name) => [name, env[name]]);
  return { ...Object.fromEntries(inherited), HOME: env.HOME ?? box.home };
}

// How the model tier is signed in. `clean`: a throwaway home and config
// directory with the credential from the environment, the way CI runs it.
// `local`: the real login, found by `claude auth status`, which costs no
// model call. `none`: neither, and the tier does not run. Only the names of
// the variables are recorded, never a value.
export function behaviorAccess(cli, box, env = process.env) {
  const named = CREDENTIALS.filter((name) => env[name]);
  if (named.length) return { mode: "clean", credential: named };
  if (cli.problem || !env.HOME) return { mode: "none", credential: [] };
  const probe = spawnSync(cli.path, ["auth", "status"], { env: localEnv(env, box), encoding: "utf8", timeout: 30_000 });
  let status = null;
  try {
    status = JSON.parse(probe.stdout);
  } catch {}
  return { mode: status?.loggedIn === true ? "local" : "none", credential: [] };
}

function sessionEnv(box, tier, access, env) {
  if (tier !== "behavior") return childEnv(box, env);
  if (access.mode === "local") return localEnv(env, box);
  return { ...childEnv(box, env), ...Object.fromEntries(access.credential.map((name) => [name, env[name]])) };
}

// What a flow may cost is in its arguments, so it is read from there.
function cap(args, flag, flow) {
  const at = args.indexOf(flag);
  const value = at === -1 ? Number.NaN : Number(args[at + 1]);
  if (!(value > 0)) throw new Error(`${flow} is a model-tier flow and must set ${flag} in its arguments`);
  return value;
}

// The most the sessions may cost and call, from their own caps. A plan over
// either limit is refused before any session starts.
export function caps(sessions) {
  const model = sessions.filter((session) => session.tier === "behavior");
  const total = (flag) => model.reduce((sum, session) => sum + cap(session.args ?? [], flag, `${session.id}/${session.name}`), 0);
  const found = { max_usd: Number(total("--max-budget-usd").toFixed(6)), max_turns: total("--max-turns") };
  if (found.max_usd > BUDGET_USD) throw new Error(`the model tier plans up to $${found.max_usd}, over its budget of $${BUDGET_USD}`);
  if (found.max_turns > MAX_MODEL_CALLS) throw new Error(`the model tier plans up to ${found.max_turns} model turns, over its limit of ${MAX_MODEL_CALLS}`);
  return found;
}

// A session signed in as the person who runs the verifier writes a project
// directory for its working directory into their real config directory, empty
// but for a memory folder, even with no session persisted. It is named after
// a sandbox directory that is thrown away, so nothing else owns it, and it is
// removed when it holds no file. A session with its own config is left alone.
const bare = (dir) => readdirSync(dir).every((name) => statSync(join(dir, name)).isDirectory() && bare(join(dir, name)));
export function forgetProjects(sessions) {
  for (const session of sessions.filter((each) => each.tier === "behavior" && !each.config)) {
    const config = session.env.CLAUDE_CONFIG_DIR ?? join(session.env.HOME ?? "", ".claude");
    const dir = join(config, "projects", session.cwd.replace(/[^A-Za-z0-9]/g, "-"));
    if (session.cwd.includes("pstack-verify-") && existsSync(dir) && bare(dir)) rmSync(dir, { recursive: true });
  }
}

// A run's `project` is the small project its session starts in, laid out in
// its working directory.
function lay(cwd, project = {}) {
  for (const [name, text] of Object.entries(project)) {
    if (isAbsolute(name) || relative(cwd, join(cwd, name)).startsWith("..")) throw new Error(`a flow file may not leave its working directory: ${name}`);
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), text);
  }
}

// The only variables a run may add to its environment are the plugin's own
// switches. Any other name would let a flow change which sheet or runtime the
// hook sees, or sign the session in.
const EXTRA_ENV = /^PSTACK_[A-Z0-9_]+$/;

// The skill directories a stage holds, for a flow whose input is made of them.
export function skillNames(stage) {
  const dir = join(stage, SKILLS);
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md"))).sort() : [];
}

// Files a run needs in its config directory: the sheet of model overrides, and
// no other name (SESSION_FILES). The path stays inside that directory, and setup records the
// digest of what it wrote so the checker can tell it was the declared text.
function placeFiles(box, files = {}) {
  return Object.fromEntries(
    Object.entries(files)
      .sort()
      .map(([name, text]) => {
        const path = join(box.config, name);
        if (isAbsolute(name) || relative(box.config, path).startsWith("..")) throw new Error(`a flow may write only inside the config directory, not ${name}`);
        if (!SESSION_FILES.includes(name)) throw new Error(`a flow may write only ${SESSION_FILES.join(", ")} in the config directory, not ${name}`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
        return [name, sha256(text)];
      }),
  );
}

// One sandbox per run: two runs at once never share a config directory. A run
// that names `share` takes the sandbox of an earlier run of its flow, which is
// how a session is resumed: the conversation it continues is in that
// directory. Runs that share one are started in the order listed. A run's
// `env` holds the plugin switches that make up its condition, such as the hook
// switched off. With no way to sign in, the model tier plans no session, and a
// model-tier run signed in as the person has no config directory of its own,
// so it may write no file there.
export function plan(flows, base, env = process.env, { stage = null, access = { mode: "clean", credential: [] } } = {}) {
  const sessions = flows
    .filter((flow) => flow.tier !== "behavior" || access.mode !== "none")
    .flatMap((flow) => {
      const boxes = new Map();
      return flow.runs.map((session) => {
        if (session.share && !boxes.has(session.share)) throw new Error(`${flow.id} ${session.name} shares the sandbox of ${session.share}, which no earlier run of the flow has`);
        const box = boxes.get(session.share) ?? sandbox(join(base, flow.id, session.name));
        boxes.set(session.name, box);
        const added = session.env ?? {};
        const bad = Object.keys(added).find((name) => !EXTRA_ENV.test(name));
        if (bad) throw new Error(`${flow.id} ${session.name} may not set ${bad}; only PSTACK_ variables`);
        const local = flow.tier === "behavior" && access.mode === "local";
        if (local && Object.keys(session.files ?? {}).length) throw new Error(`${flow.id} ${session.name} is signed in as the person, whose config directory a flow may not write`);
        const stdin = typeof session.stdin === "function" ? session.stdin({ skills: skillNames(stage) }) : (session.stdin ?? "");
        const files = placeFiles(box, session.files);
        return { id: flow.id, tier: flow.tier, ...session, stdin, cwd: box.cwd, config: local ? null : box.config, env: { ...sessionEnv(box, flow.tier, access, env), ...added }, extras: { env: added, files } };
      });
    });
  caps(sessions);
  for (const session of sessions) lay(session.cwd, session.project);
  return sessions;
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
