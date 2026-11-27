#!/usr/bin/env bun
// The push gate: nothing leaves this repository by accident on a tree the
// verifier has not passed. Two entry points share this file.
//
//   bun tools/verify/gate.mjs hook       a Claude Code PreToolUse hook; reads
//                                        the hook payload from stdin
//   bun tools/verify/gate.mjs pre-push   a git pre-push hook, run through
//                                        .pre-commit-config.yaml
//
// Both build the same facts and hand them to `decide`, which owns every
// verdict. The wrappers only gather facts and print the message.
//
// The gate never reads a receipt. It reruns `verify.mjs --tier surface` on a
// clean checkout of the commit being pushed and reads the verdict line that
// run prints, so a stale, copied or hand-written file cannot open it.
//
// PSTACK_VERIFY_GATE=off, set by the human in the environment Claude Code or
// git was started with, bypasses it and says so. A command's own prefix does
// not reach the hook's environment.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, PLUGIN } from "../plugin.mjs";
import { WATCHED } from "./paths.mjs";
import { gitEnv } from "./setup.mjs";

const VERIFY = fileURLToPath(new URL("../verify.mjs", import.meta.url));
export const BYPASS_LINE = "verify gate bypassed by PSTACK_VERIFY_GATE=off";
const MAX_ROUNDS = 3;
const ZEROS = /^0+$/;

// --- What a command line does -------------------------------------------

// Splits a command into segments of words at the operators that start a new
// command, outside quotes. Quotes are removed from the words. `$(`, a
// backtick and a parenthesis start a segment too, so `echo $(git push)` is
// seen. Heredocs and expansions inside double quotes are not followed.
export function segments(command) {
  const out = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (/\s/.test(c) && c !== "\n") {
      endWord();
    } else if ("\n;|&()`{}".includes(c)) {
      endSegment();
    } else {
      word = (word ?? "") + c;
    }
  }
  endSegment();
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "command", "exec", "nohup", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Options of git, before the subcommand, that take their value as the next word.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);

// Drops what runs before the program: variable assignments, `env` and its
// options, and shell keywords.
function program(words) {
  let at = 0;
  for (;;) {
    const word = words[at];
    if (word === undefined) return [];
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) at++;
    else if (basename(word) === "env") {
      at++;
      while (words[at] !== undefined && (words[at].startsWith("-") || ASSIGNMENT.test(words[at]))) at += words[at] === "-u" || words[at] === "-C" ? 2 : 1;
    } else return words.slice(at);
  }
}

// The command's hits in order, each with the directory it acts in: `cd x &&`
// and `git -C x` both move it. `cwd` is where the command runs.
// A hit is { kind: "push" | "pr-create", dir }.
export function hitsOf(command, cwd = ".") {
  const hits = [];
  let dir = resolve(cwd);
  for (const words of segments(command)) {
    const [head, ...rest] = program(words);
    if (head === undefined) continue;
    const name = basename(head);
    if (name === "cd" && rest[0] !== undefined && rest[0] !== "-") dir = resolve(dir, rest[0]);
    else if (SHELLS.has(name)) {
      const at = rest.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
      if (at >= 0 && rest[at + 1] !== undefined) hits.push(...hitsOf(rest[at + 1], dir));
    } else if (name === "eval") hits.push(...hitsOf(rest.join(" "), dir));
    else if (name === "git") {
      let at = 0;
      let where = dir;
      for (; rest[at]?.startsWith("-"); at++) {
        const option = rest[at];
        if (option === "-C" && rest[at + 1] !== undefined) where = resolve(where, rest[at + 1]);
        if (option.startsWith("--work-tree=")) where = resolve(where, option.slice("--work-tree=".length));
        if (GIT_VALUE_OPTIONS.has(option)) at++;
      }
      if (rest[at] === "push") hits.push({ kind: "push", dir: where });
    } else if (name === "gh") {
      let at = 0;
      for (; rest[at]?.startsWith("-"); at++) if (GH_VALUE_OPTIONS.has(rest[at])) at++;
      if (rest[at] === "pr" && rest[at + 1] === "create") hits.push({ kind: "pr-create", dir });
    }
  }
  return hits;
}

// --- What the verdict says ----------------------------------------------

// The first line of a verifier run. Only a PASS that ran every surface check
// is one: `PASS surface 2/2 | ...`. STAND-IN, PARTIAL, SKIPPED and FAIL are
// not, and neither is a RECHECK of someone else's run.
export function judgeLine(line = "") {
  const word = line.match(/^(\S+)/)?.[1] ?? null;
  const round = line.match(/\| round (\d+)$/)?.[1];
  const [, passed, of] = line.match(/^\S+ surface (\d+)\/(\d+)\b/) ?? [];
  return { word, ok: word === "PASS" && Number(of) > 0 && passed === of, round: round ? Number(round) : null };
}

const HUMAN_BYPASS = "Only the human sets PSTACK_VERIFY_GATE=off, in the environment the session started in. Do not set it.";

export function blockMessage({ line, word, round, sha }) {
  const at = sha ? ` on ${sha.slice(0, 12)}` : "";
  if (word === "BLOCKED" || (word === "FAIL" && round >= MAX_ROUNDS)) {
    return `verify gate: BLOCKED after ${round >= MAX_ROUNDS ? round : MAX_ROUNDS} failed rounds${at}. STOP. Do not edit further and do not push. Report to the human what the verifier named and where its evidence is, and wait for their word. ${HUMAN_BYPASS}\nverifier said: ${line}`;
  }
  if (word === "SKIPPED") return `verify gate: the verifier did not run${at}: ${line}. Fix: install Claude Code so \`claude\` is on PATH, then run \`bun tools/verify.mjs --tier surface\`. ${HUMAN_BYPASS}`;
  if (word === "STAND-IN") return `verify gate: the verifier ran against a stand-in CLI${at}, which proves nothing about the claude a user has. Fix: unset PSTACK_VERIFY_CLAUDE and run \`bun tools/verify.mjs --tier surface\`. ${HUMAN_BYPASS}`;
  return `verify gate: the verifier did not pass${at}${round ? ` (round ${round} of ${MAX_ROUNDS})` : ""}. Fix what it names, commit, run \`bun tools/verify.mjs --tier surface\` until it prints PASS, then push again. ${HUMAN_BYPASS}\nverifier said: ${line ?? "no verdict line"}`;
}

// Every verdict of the gate. `hits` are the pushes or pull requests asked
// for, `env` is the environment of the process that started the session, and
// `io` gathers one fact per hit, only when it is needed: the verifier costs
// seconds, so a bypass and an unwatched push never reach it.
//   io.subject(hit)  -> { sha, inScope } or null when there is nothing to push
//   io.touches(hit)  -> does the push carry a change to a watched path
//   io.verify(hit)   -> the first line of a verifier run on the hit's commit
export async function decide({ hits, env }, io) {
  if (!hits.length) return { allow: true };
  if (env.PSTACK_VERIFY_GATE === "off") return { allow: true, message: BYPASS_LINE };
  for (const hit of hits) {
    const subject = await io.subject(hit);
    if (!subject?.inScope) continue;
    if (!(await io.touches(hit, subject))) continue;
    const line = await io.verify(hit, subject);
    const verdict = judgeLine(line);
    if (!verdict.ok) return { allow: false, message: blockMessage({ line, ...verdict, sha: subject.sha }) };
  }
  return { allow: true };
}

// --- The facts, from git and from a verifier run -------------------------

const git = (dir, args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv(), maxBuffer: 1 << 28 });
const gitOut = (dir, args) => {
  const result = git(dir, args);
  return result.status === 0 ? result.stdout.trim() : null;
};

// A path is watched when it is one, or lies under one.
export const isWatched = (file, watched = WATCHED) => watched.some((path) => file === path || file.startsWith(`${path}/`));

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// What a push of `sha` carries: the commits no remote has, or no more than
// `from` has when the push says what the remote holds. Merges list their
// changes against each parent, so this errs towards more. null means it
// could not be told, which the caller reads as "touches".
function carried(dir, sha, { from, remote } = {}) {
  const not = from && !ZEROS.test(from) ? [from] : [remote ? `--remotes=${remote}` : "--remotes"];
  const result = git(dir, ["log", "-m", "--name-only", "--format=", sha, "--not", ...not]);
  return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : null;
}

// What a pull request carries: the branch against the default branch.
function againstBase(dir, sha) {
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    const mergeBase = gitOut(dir, ["merge-base", base, sha]);
    if (!mergeBase) continue;
    const result = git(dir, ["diff", "--name-only", `${mergeBase}..${sha}`]);
    return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : null;
  }
  return null;
}

// Runs the verifier on a clean checkout of `sha`, so what is judged is the
// commit and not whatever the working tree holds. Evidence goes to the git
// directory of the repository pushed from, so failed rounds add up there.
export function verifyCommit(dir, sha, env = process.env) {
  const evidence = gitOut(dir, ["rev-parse", "--absolute-git-dir"]);
  const scratch = mkdtempSync(join(tmpdir(), "pstack-gate-"));
  const tree = join(scratch, "tree");
  try {
    const added = git(dir, ["worktree", "add", "--detach", "--quiet", tree, sha]);
    if (added.status !== 0) return `FAIL could not check out ${sha}: ${added.stderr.trim()}`;
    const run = spawnSync(process.execPath, [VERIFY, "--tier", "surface", "--tree", tree, "--evidence", join(evidence, "pstack-verify")], {
      encoding: "utf8",
      env: gitEnv(env),
      timeout: 10 * 60_000,
      maxBuffer: 1 << 28,
    });
    if (run.error) return `FAIL the verifier did not run: ${run.error.message}`;
    const first = run.stdout.split("\n")[0];
    // A crash prints on stderr and nothing on stdout.
    return first || `FAIL the verifier printed no verdict: ${run.stderr.trim().split("\n")[0]}`;
  } finally {
    git(dir, ["worktree", "remove", "--force", tree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The `io` the wrappers hand to `decide`. A hit knows its directory; a
// pre-push hit also knows the commit and what the remote holds.
export function gitIo(env = process.env) {
  return {
    subject(hit) {
      const sha = hit.sha ?? gitOut(hit.dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      if (!sha || ZEROS.test(sha)) return null;
      // Only a tree that holds the plugin is one this verifier judges.
      return { sha, inScope: git(hit.dir, ["cat-file", "-e", `${sha}:${PLUGIN}`]).status === 0 };
    },
    touches(hit, { sha }) {
      const files = hit.kind === "pr-create" ? againstBase(hit.dir, sha) : carried(hit.dir, sha, hit);
      return files === null || files.some((file) => isWatched(file));
    },
    verify: (hit, { sha }) => verifyCommit(hit.dir, sha, env),
  };
}

// --- The two entry points -------------------------------------------------

// The hook payload names the command and where it runs. A directory that is
// not one (an unresolved `cd $X`) falls back to where the session is.
export function hookHits(payload) {
  if (payload?.tool_name !== "Bash") return [];
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return [];
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  return hitsOf(command, cwd).map((hit) => ({ ...hit, dir: isDirectory(hit.dir) ? hit.dir : cwd }));
}

// pre-commit and prek do not forward git's stdin; they export the ref being
// pushed and the one the remote holds. A bare git hook gets both on stdin.
export function prePushHits(env, stdin, cwd = process.cwd()) {
  const named = env.PRE_COMMIT_TO_REF ? [{ sha: env.PRE_COMMIT_TO_REF, from: env.PRE_COMMIT_FROM_REF }] : [];
  const refs = named.length
    ? named
    : stdin
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields.length >= 4)
        .map(([, sha, , from]) => ({ sha, from }));
  const remote = env.PRE_COMMIT_REMOTE_NAME;
  return refs.filter((ref) => !ZEROS.test(ref.sha)).map((ref) => ({ kind: "push", dir: cwd, remote, ...ref }));
}

async function main(argv, env, stdin) {
  const entry = argv[0];
  if (!["hook", "pre-push"].includes(entry)) {
    console.error("usage: bun tools/verify/gate.mjs hook|pre-push");
    return 2;
  }
  let hits;
  if (entry === "hook") {
    try {
      hits = hookHits(JSON.parse(stdin));
    } catch {
      // A payload this gate cannot read is not a push it can see.
      return 0;
    }
  } else hits = prePushHits(env, stdin);
  const verdict = await decide({ hits, env }, gitIo(env));
  if (verdict.message) console.error(verdict.message);
  return verdict.allow ? 0 : entry === "hook" ? 2 : 1;
}

if (isMain(import.meta.url)) {
  // A terminal has no stdin to read: git and pre-commit pipe or close it.
  const stdin = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  process.exit(await main(process.argv.slice(2), process.env, stdin));
}
