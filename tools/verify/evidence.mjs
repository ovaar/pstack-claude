// What a run leaves behind: evidence.md for people, evidence.json for tools,
// and receipt.json for a gate. The three are redacted, because they are what
// gets pasted into a pull request. The traces beside them stay byte for byte
// as the driver hashed them and are not for publishing.

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const HOME_PATH = /(?:\/Users|\/home)\/[^/\s"'`\\]+|[A-Za-z]:\\+Users\\+[^\\\s"'`]+/g;
// A home path as the CLI writes it into the name of a project directory.
const HOME_SLUG = /-(?:Users|home)-[A-Za-z0-9_]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Shaped by prefix, so a sha256 digest, which the evidence quotes, is kept.
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name is taken for a person's or a machine's only where it stands for
// one: as a whole path segment, or on its side of an @. Anywhere else it is
// a word, and accounts are called user, claude and test.
export const asUser = (name) => new RegExp(`(?<=[/\\\\])${literal(name)}(?=[/\\\\"'\`\\s]|$)|(?<![A-Za-z0-9._-])${literal(name)}(?=@)`, "g");
export const asHost = (name) => new RegExp(`(?<=@)${literal(name)}(?![A-Za-z0-9-])`, "g");

export function thisMachine() {
  const or = (read, otherwise) => {
    try {
      return read();
    } catch {
      return otherwise;
    }
  };
  return { home: homedir(), user: or(() => userInfo().username, null), host: hostname(), tmp: [or(() => realpathSync(tmpdir()), tmpdir()), tmpdir()] };
}

// `places` maps a path of this run to the name it is published under.
export function redact(text, { places = {}, ...who } = {}) {
  const { home, user, host, tmp } = { ...thisMachine(), ...who };
  const exact = [...Object.entries(places), ...tmp.map((dir) => [dir, "<tmp>"]), [home, "~"]].filter(([path]) => path.length > 1);
  // Longest first, so a stage inside the home directory is named as the
  // stage. Whole names only: /tmp is not the start of /tmpfs.
  let out = exact.sort(([a], [b]) => b.length - a.length).reduce((rest, [path, name]) => rest.replace(new RegExp(`${literal(path)}(?![A-Za-z0-9_-])`, "g"), name), text);
  out = out.replace(HOME_PATH, "~").replace(HOME_SLUG, "-~").replace(EMAIL, "<email>").replace(TOKEN, "<token>");
  if (user) out = out.replace(asUser(user), "<user>");
  if (host) out = out.replace(asHost(host), "<host>");
  return out;
}

const cell = (text) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

// The table is what gets pasted into a pull request, so a failed row carries
// every failed assertion with what was seen and what was wanted.
function evidenceCell(check) {
  if (check.verdict === "pass") {
    return `${check.assertions.map((item) => item.saw).join("; ")}; ${check.integrity.length} of ${check.integrity.length} integrity rules hold`;
  }
  if (check.verdict !== "fail") return check.reason;
  const failed = [...check.integrity, ...check.assertions].filter((item) => !item.ok).map((item) => `${item.id}: saw ${item.saw}, want ${item.want}`);
  return [...failed, ...(check.reason ? [check.reason] : [])].join("; ");
}

export function markdown(result) {
  const observed = result.checks.flatMap((check) => (check.observations ?? []).map((seen) => `- ${check.id} ${seen.run}: ${seen.text}`));
  return [
    result.line,
    "",
    `- subject_id: ${result.subject_id}`,
    `- tree: ${result.tree_id}`,
    `- stage hash: ${result.stage_hash}`,
    `- CLI: ${result.cli_version ?? "none"}${result.cli_path ? ` at ${result.cli_path}, sha256 ${result.cli_sha256}` : ""} (checks verified on ${result.cli_verified})`,
    ...(result.cli_stand_in ? [`- CLI stand-in: ${result.cli_stand_in}. No verdict on the claude a user has.`] : []),
    `- cost: $${result.cost_usd}`,
    `- run: ${result.run}`,
    ...(result.rechecked_at ? [`- rechecked: ${result.rechecked_at}`] : []),
    "",
    "| Check | Verdict | Evidence |",
    "| --- | --- | --- |",
    ...result.checks.map((check) => `| ${check.id} ${check.title} | ${check.verdict} | ${cell(evidenceCell(check))} |`),
    "",
    "## Observations",
    "",
    ...(observed.length ? observed : ["None."]),
    "",
  ].join("\n");
}

// A gate must read `checks`, not `verdict`: the word says nothing failed, the
// list says which checks ran and how each one ended.
export function receipt(result) {
  return {
    subject_id: result.subject_id,
    tree_id: result.tree_id,
    verdict: result.verdict,
    line: result.line,
    selection: result.selection,
    checks: result.checks.map(({ id, tier, verdict, reason, failed }) => ({ id, tier, verdict, ...(reason ? { reason } : {}), ...(failed?.length ? { failed } : {}) })),
    stage_hash: result.stage_hash,
    cli_version: result.cli_version,
    cli_path: result.cli_path,
    cli_sha256: result.cli_sha256,
    ...(result.cli_stand_in ? { cli_stand_in: result.cli_stand_in } : {}),
    cost_usd: result.cost_usd,
    round: result.round,
    run: result.run,
    ...(result.rechecked_at ? { rechecked_at: result.rechecked_at } : {}),
    authority: "none: written on this machine and unsigned. It says what was seen here; a gate reruns the checks.",
  };
}

// Returns evidence.md as written, so what is printed is what was redacted.
// A rerun of the checker carries `rechecked_at` and is written beside the
// run's own files, never over them: what the run found stays on record.
export function writeEvidence(dir, result) {
  const places = { [result.stage]: "<stage>", ...(result.sandbox ? { [result.sandbox]: "<sandbox>" } : {}) };
  const tidy = (text) => redact(text, { places });
  const json = (value) => tidy(`${JSON.stringify(value, null, 2)}\n`);
  const named = (file) => join(dir, result.rechecked_at ? file.replace(".", ".recheck.") : file);
  const report = tidy(markdown(result));
  writeFileSync(named("evidence.md"), report);
  writeFileSync(named("evidence.json"), json(result));
  writeFileSync(named("receipt.json"), json(receipt(result)));
  return report;
}

const roundsFile = (root) => join(root, "rounds.json");
const failedRounds = (root) => (existsSync(roundsFile(root)) ? JSON.parse(readFileSync(roundsFile(root), "utf8")) : []);

// A round is one more failed run since the last pass.
export const nextRound = (root) => failedRounds(root).length + 1;

// Only PASS starts the count over, and only when it holds every check a
// failed round held: a pass reached with fewer checks clears nothing.
// Returns the checks that kept the count from starting over.
export function recordRound(root, result) {
  const rounds = failedRounds(root);
  const ids = result.checks.map((check) => check.id);
  const save = (kept) => writeFileSync(roundsFile(root), `${JSON.stringify(kept, null, 2)}\n`);
  if (result.verdict === "FAIL") save([...rounds, { run: result.run, subject_id: result.subject_id, checks: ids, failed: result.checks.flatMap((check) => check.failed ?? []) }]);
  if (result.verdict !== "PASS") return [];
  const dropped = [...new Set(rounds.flatMap((round) => round.checks ?? []))].filter((id) => !ids.includes(id));
  if (!dropped.length) save([]);
  return dropped;
}

// Run directories sort by time, and each holds its own stage.
export function prune(root, keep = 5) {
  const runs = join(root, "runs");
  for (const run of readdirSync(runs).sort().slice(0, -keep)) rmSync(join(runs, run), { recursive: true, force: true });
}
