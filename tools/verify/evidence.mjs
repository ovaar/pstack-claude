// What a run leaves behind: evidence.md for people, evidence.json for tools,
// and receipt.json for a gate. The three are redacted, because they are what
// gets pasted into a pull request. The traces beside them stay byte for byte
// as the driver hashed them and are not for publishing.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME_PATH = /(?:\/Users|\/home)\/[^/\s"'`\\]+|[A-Za-z]:\\+Users\\+[^\\\s"'`]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Shaped by prefix, so a sha256 digest, which the evidence quotes, is kept.
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

export function redact(text, home = homedir()) {
  const local = home.length > 1 ? text.replaceAll(home, "~") : text;
  return local.replace(HOME_PATH, "~").replace(EMAIL, "<email>").replace(TOKEN, "<token>");
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
    `- stage hash: ${result.stage_hash}`,
    `- stage: ${result.stage}`,
    `- CLI: ${result.cli_version ?? "none"} (checks verified on ${result.cli_verified})`,
    `- cost: $${result.cost_usd}`,
    `- run: ${result.run}`,
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
    verdict: result.verdict,
    line: result.line,
    selection: result.selection,
    checks: result.checks.map(({ id, tier, verdict, reason, failed }) => ({ id, tier, verdict, ...(reason ? { reason } : {}), ...(failed?.length ? { failed } : {}) })),
    stage_hash: result.stage_hash,
    cli_version: result.cli_version,
    cost_usd: result.cost_usd,
    round: result.round,
    run: result.run,
  };
}

// Returns evidence.md as written, so what is printed is what was redacted.
export function writeEvidence(dir, result) {
  const json = (value) => redact(`${JSON.stringify(value, null, 2)}\n`);
  const report = redact(markdown(result));
  writeFileSync(join(dir, "evidence.md"), report);
  writeFileSync(join(dir, "evidence.json"), json(result));
  writeFileSync(join(dir, "receipt.json"), json(receipt(result)));
  return report;
}

const roundsFile = (root) => join(root, "rounds.json");
const failedRounds = (root) => (existsSync(roundsFile(root)) ? JSON.parse(readFileSync(roundsFile(root), "utf8")) : []);

// A round is one more failed run since the last full pass. A run that
// passed with a check skipped leaves the count alone: running one flow that
// passes must not clear the failures of another.
export const nextRound = (root) => failedRounds(root).length + 1;

export function recordRound(root, result) {
  const full = result.checks.every((check) => check.verdict === "pass");
  if (result.verdict !== "FAIL" && !full) return;
  const failed = result.checks.flatMap((check) => check.failed ?? []);
  const rounds = full ? [] : [...failedRounds(root), { run: result.run, subject_id: result.subject_id, failed }];
  writeFileSync(roundsFile(root), `${JSON.stringify(rounds, null, 2)}\n`);
}

// Run directories sort by time. A stage outlives its run only until the run
// is dropped here.
export function prune(root, sandboxes, keep = 5) {
  const runs = readdirSync(join(root, "runs")).sort();
  const kept = new Set(runs.slice(-keep));
  for (const run of runs) {
    if (!kept.has(run)) rmSync(join(root, "runs", run), { recursive: true, force: true });
  }
  for (const run of existsSync(sandboxes) ? readdirSync(sandboxes) : []) {
    if (!kept.has(run)) rmSync(join(sandboxes, run), { recursive: true, force: true });
  }
}
