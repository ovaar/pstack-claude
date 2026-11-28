// Keeps the verifier honest. A check that passes on a broken plugin is worse
// than no check, so this plants known mistakes in a throwaway copy of the
// tree, runs the real verifier on the copy with --tree, and reports for each
// mistake whether the check that should catch it did.
//
//   bun tools/verify.mjs honesty [--tree <checkout>] [--mutants <dir>] [--mutant <id>] [--tier surface] [--out <file>] [--keep] [--base <ref>]
//
// With --base <ref> it runs no verifier and compares the committed mistakes and
// baseline.json with the merge base of HEAD and <ref>; see ratchet.
//
// One JSON file per mistake under tools/verify/mutants/:
//
//   id           the file name without .json
//   description  what is broken and which regression it re-creates
//   edits        the edit as data: replace (path, find, with), write (path,
//                content), delete (path) or chmod (path, mode)
//   catches      { check, assertion? }: the surface check that must fail,
//                and optionally the assertion that must be among its failures
//   known_escape { reason, future_check } in place of catches: a mistake no
//                check catches yet. It is reported and does not fail the run,
//                but a check that starts catching it does, until the file is
//                promoted to `catches`.
//
// This module starts the verifier as a process and writes only into
// directories it made. It is outside tools/verify/ because the three roles
// there may not start the verifier or one another.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT } from "./verify/paths.mjs";
import { buildStage, gitEnv, snapshot } from "./verify/setup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
export const MUTANTS_DIR = join(here, "verify", "mutants");
const VERIFY = join(here, "verify.mjs");
const USAGE = "usage: bun tools/verify.mjs honesty [--tree <checkout>] [--mutants <dir>] [--mutant <id>] [--tier surface] [--out <file>] [--keep] [--base <ref>]";
// A planted mistake is judged by driving the real CLI, which for the model
// tier would spend model calls on every run and judge a sample. The model
// tier's proof is its doctored recordings instead: tests/verify/honesty.test.mjs
// turns every assertion of every behavior check with one.
const MODEL_TIER = "honesty plants mistakes for the surface tier only. The model tier is proved by doctored recordings: bun test tests/verify/honesty.test.mjs";
const OPS = { replace: ["path", "find", "with"], write: ["path", "content"], delete: ["path"], chmod: ["path", "mode"] };

export class PlantDidNotApply extends Error {}

// What is wrong with a mutant file, or null. Shared with the tests that hold
// the committed files to the same shape.
export function problem(mutant, file) {
  const id = file.replace(/\.json$/, "");
  if (typeof mutant !== "object" || mutant === null || Array.isArray(mutant)) return "is not an object";
  const unknown = Object.keys(mutant).filter((key) => !["id", "description", "edits", "catches", "known_escape"].includes(key));
  if (unknown.length) return `has unknown keys ${unknown.join(", ")}`;
  if (mutant.id !== id) return `has id ${JSON.stringify(mutant.id)}, want ${id}`;
  if (typeof mutant.description !== "string" || !mutant.description.trim()) return "has no description";
  if (!Array.isArray(mutant.edits) || !mutant.edits.length) return "has no edits";
  for (const edit of mutant.edits) {
    const wanted = OPS[edit?.op];
    if (!wanted) return `has an edit with op ${JSON.stringify(edit?.op)}`;
    const keys = Object.keys(edit).filter((key) => key !== "op").sort();
    if (JSON.stringify(keys) !== JSON.stringify([...wanted].sort())) return `has a ${edit.op} edit with keys ${keys.join(", ")}, want ${wanted.join(", ")}`;
    if (wanted.some((key) => typeof edit[key] !== "string")) return `has a ${edit.op} edit with a value that is not a string`;
    if (!inProduct(edit.path)) return `edits ${edit.path}, which is not under ${PRODUCT.join(", ")}`;
    if (edit.op === "replace" && edit.find === "") return "has a replace edit that finds the empty string";
    if (edit.op === "chmod" && !/^[0-7]{3}$/.test(edit.mode)) return `has chmod mode ${edit.mode}, want three octal digits`;
  }
  const { catches, known_escape: escape } = mutant;
  if (Boolean(catches) === Boolean(escape)) return "has to hold exactly one of catches and known_escape";
  if (catches && (typeof catches.check !== "string" || (catches.assertion !== undefined && typeof catches.assertion !== "string") || Object.keys(catches).some((key) => !["check", "assertion"].includes(key)))) return "has catches other than { check, assertion? }";
  if (escape && (typeof escape.reason !== "string" || !escape.reason.trim() || typeof escape.future_check !== "string" || !escape.future_check)) return "has a known_escape without a reason and a future_check";
  return null;
}

// Only what a user loads can be planted: the verifier's own paths are the
// judge, and a mistake there is not a mistake in the product.
function inProduct(path) {
  const clean = normalize(path);
  return !isAbsolute(path) && clean === path && !clean.startsWith("..") && PRODUCT.some((root) => clean === root || clean.startsWith(`${root}/`));
}

export function loadMutants(dir = MUTANTS_DIR) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      let mutant;
      try {
        mutant = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch (err) {
        throw new Error(`${file}: ${err.message}`);
      }
      const wrong = problem(mutant, file);
      if (wrong) throw new Error(`${file} ${wrong}`);
      return mutant;
    });
}

function git(dir, ...args) {
  const identity = ["-c", "user.name=verify-honesty", "-c", "user.email=verify-honesty@example.invalid", "-c", "commit.gpgsign=false"];
  const result = spawnSync("git", ["-C", dir, ...identity, ...args], { encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

// A repository of its own holding the product paths of the tree under test,
// committed, so that what the verifier snapshots is that tree and the
// working tree it came from is never touched.
function clone(snap, dir) {
  buildStage(snap, dir);
  git(dir, "init", "--quiet");
  // A commit in a directory inside another repository would land there.
  if (realpathSync(git(dir, "rev-parse", "--absolute-git-dir").trim()) !== join(realpathSync(dir), ".git")) throw new Error(`${dir} is inside another repository`);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "tree under test");
  return dir;
}

function must(dir, path) {
  const file = join(dir, path);
  if (!existsSync(file)) throw new PlantDidNotApply(`${path} is not there`);
  return file;
}

export function plant(dir, edits) {
  for (const edit of edits) {
    if (edit.op === "write") {
      const file = join(dir, edit.path);
      if (existsSync(file) && readFileSync(file, "utf8") === edit.content) throw new PlantDidNotApply(`${edit.path} already holds that content`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, edit.content);
    } else if (edit.op === "delete") {
      rmSync(must(dir, edit.path), { recursive: true, force: true });
    } else if (edit.op === "chmod") {
      const file = must(dir, edit.path);
      if ((statSync(file).mode & 0o777) === parseInt(edit.mode, 8)) throw new PlantDidNotApply(`${edit.path} already has mode ${edit.mode}`);
      chmodSync(file, parseInt(edit.mode, 8));
    } else {
      const file = must(dir, edit.path);
      const text = readFileSync(file, "utf8");
      if (!text.includes(edit.find)) throw new PlantDidNotApply(`${edit.path} does not hold ${JSON.stringify(edit.find)}`);
      writeFileSync(file, text.replace(edit.find, () => edit.with));
    }
  }
  // Whatever the edits claimed, the tree the verifier snapshots must differ.
  if (!git(dir, "status", "--porcelain").trim()) throw new PlantDidNotApply("the edits left the tree as it was");
}

// The real verifier on a tree, judged by its own structured result: which
// checks ran and which assertions failed.
function verify(tree, { tier, flow, root, env }) {
  const args = [VERIFY, "--tier", tier, "--tree", tree, "--evidence", root, ...(flow ? ["--flow", flow] : [])];
  const ran = spawnSync(process.execPath, args, { encoding: "utf8", env, maxBuffer: 1 << 26 });
  const runs = existsSync(join(root, "runs")) ? readdirSync(join(root, "runs")).sort() : [];
  if (!runs.length) return { error: `the verifier left no run: ${(ran.stderr || ran.stdout).trim().split("\n").at(-1)}` };
  const receipt = JSON.parse(readFileSync(join(root, "runs", runs.at(-1), "receipt.json"), "utf8"));
  return { receipt, verdict: receipt.verdict, checks: receipt.checks, dir: join(root, "runs", runs.at(-1)) };
}

// A check the run left out of its selection is neither a pass nor a failure.
const failing = (run) => run.checks.filter((each) => ["fail", "unobservable"].includes(each.verdict)).map((each) => each.id);

// One mutant: caught, escaped, a known escape that still escapes, or a
// known escape that something caught after all (the file is out of date).
export function judge(mutant, run) {
  if (run.error) return { status: "error", note: run.error };
  const { check, assertion } = mutant.catches ?? {};
  const row = run.checks.find((each) => each.id === check);
  if (mutant.known_escape) {
    const hit = failing(run);
    return hit.length ? { status: "promote", note: `${hit.join(", ")} now fails: blind spot closed, move the file to catches` } : { status: "known-escape", note: `no check fails; ${mutant.known_escape.future_check} is to catch it` };
  }
  if (!row) return { status: "error", note: `the verifier did not run check ${check}` };
  if (row.tier !== "surface") return { status: "error", note: `${check} is a ${row.tier} check: honesty plants mistakes for the surface tier only` };
  // A check that cannot see the evidence it needs fails the tree in the
  // verifier's own verdict, as a failed assertion does. That is a catch of a
  // mistake that stops the evidence from arising, such as a deleted hooks
  // file. It names no assertion, so a mutant that names one is not caught by it.
  if (row.verdict === "unobservable" && !assertion) return { status: "caught", note: `${check} unobservable: ${row.reason}` };
  const others = failing(run).filter((id) => id !== check);
  if (row.verdict !== "fail") return { status: "escaped", note: `${check} ${row.verdict}${others.length ? `, other failures: ${others.join(", ")}` : ""}` };
  if (assertion && !(row.failed ?? []).includes(`${check}.${assertion}`)) return { status: "escaped", note: `${check} failed on ${(row.failed ?? []).join(", ")} and not on ${check}.${assertion}` };
  return { status: "caught", note: (row.failed ?? []).join(", ") };
}

// The verifier ran nothing: no check was selected, or the CLI was not there.
function skipped(control, tier) {
  if (!control.checks.some((each) => each.selected)) return `the verifier ran no check: no check in the ${tier} tier`;
  return "the verifier ran no check: no claude CLI";
}

const FAILS = ["escaped", "promote", "not-applied", "error"];

export function honesty({ tree = repo, mutants, tier = "surface", only = null, keep = false, env = process.env }) {
  const scratch = mkdtempSync(join(tmpdir(), "pstack-honesty-"));
  try {
    const snap = snapshot(tree);
    const rows = [];
    const named = only ? mutants.filter((mutant) => mutant.id === only) : mutants;
    if (only && !named.length) throw new Error(`no mutant ${only}; mutants: ${mutants.map((mutant) => mutant.id).join(", ")}`);

    // Without this the catches mean nothing: a tree the verifier fails
    // already fails every planted mistake.
    const base = clone(snap, join(scratch, "control"));
    const control = verify(base, { tier, root: join(scratch, "control-evidence"), env });
    const controlWord = control.error ?? (control.verdict === "SKIPPED" ? skipped(control, tier) : failing(control).length ? `the untouched tree fails ${failing(control).join(", ")}` : null);
    if (controlWord) return { rows, control: { ok: false, note: controlWord }, verdict: control.verdict, scratch: keep ? scratch : null, exit: 1 };

    for (const mutant of named) {
      const dir = clone(snap, join(scratch, mutant.id));
      try {
        plant(dir, mutant.edits);
      } catch (err) {
        if (!(err instanceof PlantDidNotApply)) throw err;
        rows.push({ id: mutant.id, status: "not-applied", note: `PLANT DID NOT APPLY: ${err.message}`, expect: expectation(mutant) });
        continue;
      }
      // A caught mutant is driven through its check alone. A known escape is
      // driven through everything, since any check may be the one that
      // starts to catch it.
      const run = verify(dir, { tier, flow: mutant.catches?.check, root: join(scratch, `${mutant.id}-evidence`), env });
      rows.push({ id: mutant.id, ...judge(mutant, run), expect: expectation(mutant) });
    }
    return { rows, control: { ok: true, note: control.verdict }, verdict: control.verdict, scratch: keep ? scratch : null, exit: rows.some((row) => FAILS.includes(row.status)) ? 1 : 0 };
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  }
}

const expectation = (mutant) => (mutant.catches ? `${mutant.catches.check}${mutant.catches.assertion ? `.${mutant.catches.assertion}` : ""}` : `${mutant.known_escape.future_check} (future)`);

export function table({ rows, control, verdict, scratch }) {
  if (!control.ok) return `honesty: FAIL, ${control.note}\n`;
  const count = (status) => rows.filter((row) => row.status === status).length;
  const caught = count("caught");
  const known = count("known-escape");
  const bad = rows.filter((row) => FAILS.includes(row.status));
  const head = `honesty: ${bad.length ? "FAIL" : "OK"}, ${caught} of ${rows.length} caught, ${known} known escape${known === 1 ? "" : "s"}, ${bad.length} failing`;
  const lines = [head, ...(verdict === "STAND-IN" ? ["the verifier ran against a stand-in for the CLI: no verdict on the claude a user has"] : []), "", "| mutant | expected catcher | result | detail |", "| --- | --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.id} | ${row.expect} | ${row.status === "caught" ? "caught" : row.status === "known-escape" ? "known escape" : row.status.toUpperCase()} | ${row.note.replaceAll("|", "\\|")} |`);
  if (scratch) lines.push("", `kept: ${scratch}`);
  return `${lines.join("\n")}\n`;
}

// The ratchet against a base. A test inside one commit cannot stop that same
// commit from raising its own baseline, so the committed files are compared
// with what the base branch holds: the known escapes may only go down, and a
// mistake the base catches stays caught by the same check.
const BASELINE = "tools/verify/baseline.json";
const MUTANTS = "tools/verify/mutants";

function show(dir, ref, path) {
  const result = spawnSync("git", ["-C", dir, "show", `${ref}:${path}`], { encoding: "utf8", env: gitEnv(), maxBuffer: 1 << 24 });
  return result.status === 0 ? result.stdout : null;
}

// What `ref` holds, or null where it holds no baseline yet: the first
// commit that introduces the ratchet has nothing to be compared with.
export function atRef(dir, ref) {
  const baseline = show(dir, ref, BASELINE);
  if (baseline === null) return null;
  const listed = spawnSync("git", ["-C", dir, "ls-tree", "--name-only", `${ref}:${MUTANTS}`], { encoding: "utf8", env: gitEnv() });
  const files = listed.status === 0 ? listed.stdout.split("\n").filter((file) => file.endsWith(".json")) : [];
  return { baseline: JSON.parse(baseline), mutants: files.map((file) => JSON.parse(show(dir, ref, `${MUTANTS}/${file}`))) };
}

export function atHead(dir) {
  return { baseline: JSON.parse(readFileSync(join(dir, BASELINE), "utf8")), mutants: loadMutants(join(dir, MUTANTS)) };
}

// What the head does that the base does not allow; empty when nothing.
export function ratchet(base, head) {
  if (!base) return [];
  const wrong = [];
  const escapes = head.mutants.filter((mutant) => mutant.known_escape).length;
  const was = base.mutants.filter((mutant) => mutant.known_escape).length;
  if (head.baseline.known_escapes > base.baseline.known_escapes) wrong.push(`baseline.json raises the known escapes from ${base.baseline.known_escapes} to ${head.baseline.known_escapes}`);
  if (escapes > was) wrong.push(`${escapes} known escapes where the base has ${was}`);
  for (const old of base.mutants.filter((mutant) => mutant.catches)) {
    const now = head.mutants.find((mutant) => mutant.id === old.id);
    if (!now) wrong.push(`${old.id} caught by ${expectation(old)} on the base, and is gone`);
    else if (!now.catches) wrong.push(`${old.id} caught by ${expectation(old)} on the base, and is now a known escape`);
    else if (now.catches.check !== old.catches.check || (old.catches.assertion !== undefined && now.catches.assertion !== old.catches.assertion)) wrong.push(`${old.id} expected ${expectation(old)} on the base, and ${expectation(now)} now`);
  }
  return wrong;
}

// The merge base of HEAD and `ref`, so a branch is compared with where it
// left the base, not with what the base has gained since.
export function mergeBase(dir, ref) {
  const result = spawnSync("git", ["-C", dir, "merge-base", "HEAD", ref], { encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) throw new Error(`no merge base of HEAD and ${ref}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function parse(args) {
  const options = { tree: repo, mutants: MUTANTS_DIR, mutant: null, tier: "surface", out: null, base: null, keep: false };
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (args[i] === "--keep") options.keep = true;
    else if (args[i].startsWith("--") && Object.hasOwn(options, name) && name !== "keep" && args[i + 1] !== undefined) options[name] = args[++i];
    else throw new Error(USAGE);
  }
  if (["behavior", "all"].includes(options.tier)) throw new Error(MODEL_TIER);
  if (options.tier !== "surface") throw new Error(USAGE);
  return options;
}

export function main(args) {
  const options = parse(args);
  if (options.base) {
    const wrong = ratchet(atRef(options.tree, mergeBase(options.tree, options.base)), atHead(options.tree));
    process.stdout.write(wrong.length ? `ratchet: FAIL\n${wrong.map((line) => `- ${line}`).join("\n")}\n` : `ratchet: OK against ${options.base}\n`);
    return wrong.length ? 1 : 0;
  }
  const result = honesty({ tree: options.tree, mutants: loadMutants(options.mutants), tier: options.tier, only: options.mutant, keep: options.keep });
  const text = table(result);
  process.stdout.write(text);
  if (options.out) writeFileSync(options.out, text);
  return result.exit;
}
