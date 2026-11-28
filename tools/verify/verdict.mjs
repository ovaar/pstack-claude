#!/usr/bin/env bun
// Reads the first line a verifier run prints and says whether it is enough
// for what is asking. The push gate imports it, and the CI jobs run it on the
// line they captured, so the gate and CI read a verdict the same way.
//
//   bun tools/verify/verdict.mjs surface|all < first-line
//
// Exit 0 when the line is accepted, 1 with the reason on stderr when not.
//
// The line is `WORD <tier> | <tier> | ... | round N`, one part per tier in
// the order the checker lists them. A tier part is `surface 7/7`,
// `behavior 5/5 (15 model calls, $0.0420)`, `behavior NOT RUN`,
// `behavior NOT RUN: no credential`, `behavior NOT BUILT`, or `surface: <why
// the CLI could not run>`. A run over budget adds a part and is FAIL.
//
// surface: what the push gate and the surface CI job ask. Every surface check
//   ran and passed (n/n, n > 0), and the word is PASS, or PARTIAL with every
//   other tier NOT RUN (with or without a reason) or NOT BUILT. A surface-only
//   run prints PARTIAL once a behavior check exists, and that is expected.
// all: what the behavior CI job asks. PASS, and every tier n/n.
//
// STAND-IN, SKIPPED, FAIL and a RECHECK of a run are never accepted.

import { readFileSync } from "node:fs";

import { isMain } from "../plugin.mjs";

const RAN = /^([a-z]+) ([1-9][0-9]*)\/([0-9]+)(?: \(.*\))?$/;
const LEFT_OUT = /^[a-z]+ NOT (?:RUN(?:: .+)?|BUILT)$/;

// { word, ok, round, reason } for a first line, judged for `scope`.
export function judgeLine(line = "", scope = "surface") {
  const text = typeof line === "string" ? line : "";
  const word = text.match(/^(\S+)/)?.[1] ?? null;
  const round = text.match(/ \| round (\d+)$/)?.[1];
  const result = (ok, reason = null) => ({ word, ok, round: round ? Number(round) : null, reason });
  if (!round) return result(false, "no round at the end of the line");
  const parts = text.slice(word.length + 1, text.length - ` | round ${round}`.length).split(" | ");
  const tiers = parts.map((part) => {
    const ran = part.match(RAN);
    return { part, tier: ran?.[1] ?? part.split(/[ :]/)[0], done: Boolean(ran) && ran[2] === ran[3], leftOut: LEFT_OUT.test(part) };
  });
  const surface = tiers.find((each) => each.tier === "surface");
  if (!surface?.done) return result(false, `the surface tier did not run in full: ${surface?.part ?? "no surface part"}`);
  if (scope === "all") {
    if (word !== "PASS") return result(false, `the word is ${word}, and only PASS runs every tier`);
    const short = tiers.filter((each) => !each.done);
    return short.length ? result(false, `not every tier ran in full: ${short.map((each) => each.part).join(", ")}`) : result(true);
  }
  if (!["PASS", "PARTIAL"].includes(word)) return result(false, `the word is ${word}`);
  const unread = tiers.filter((each) => !each.done && !each.leftOut);
  if (unread.length) return result(false, `a tier neither ran in full nor was left out: ${unread.map((each) => each.part).join(", ")}`);
  if (word === "PASS") return result(true);
  const other = tiers.filter((each) => each !== surface && !each.leftOut);
  return other.length ? result(false, `a tier other than surface ran or failed to: ${other.map((each) => each.part).join(", ")}`) : result(true);
}

if (isMain(import.meta.url)) {
  const scope = process.argv[2];
  if (!["surface", "all"].includes(scope) || process.argv.length !== 3) {
    console.error("usage: bun tools/verify/verdict.mjs surface|all < first-line");
    process.exit(2);
  }
  const line = readFileSync(0, "utf8").split("\n")[0];
  const { ok, reason } = judgeLine(line, scope);
  if (!ok) console.error(`not accepted for ${scope}: ${reason}`);
  process.exit(ok ? 0 : 1);
}
