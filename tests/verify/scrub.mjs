#!/usr/bin/env bun
// Turns a trace from a real run into a fixture fit for a public repository.
//
//   bun tests/verify/scrub.mjs <run-directory> <check>/<run> <fixture-name>
//
// The run directory is the one `bun tools/verify.mjs` prints as `evidence:`.
// The stage path becomes <STAGE>, which the tests point at a stage of their
// own, and everything else that names this machine becomes a placeholder.
// `leaks` is what tests/verify/fixtures-clean.test.mjs holds every fixture to.

import { readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { isMain } from "../../tools/plugin.mjs";
import { redact } from "../../tools/verify/evidence.mjs";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const MAX_BYTES = 64 * 1024;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// The CLI names a project directory after its working directory this way.
const slug = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
// A name inside a longer identifier, such as root in fix-root-causes, names
// nobody.
const standsAlone = (name) => new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`);

export function scrub(text, stage) {
  const sandbox = dirname(stage);
  const ids = new Map();
  // Numbered in order of appearance, so two events that shared an id still do.
  const placeholder = (id) => ids.get(id) ?? ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`).get(id);
  return text
    .replaceAll(stage, "<STAGE>")
    .replaceAll(sandbox, "<SANDBOX>")
    .replaceAll(slug(sandbox), "-SANDBOX")
    .replace(UUID, placeholder)
    .replace(/cc-socks\/\d+\.sock/g, "cc-socks/0.sock");
}

export function leaks(text, user = userInfo().username, host = hostname()) {
  const found = [];
  if (text.includes("/Users/") || text.includes("-Users-")) found.push("a /Users/ path");
  if (text.includes("/home/") || text.includes("-home-")) found.push("a /home/ path");
  if (/\/var\/folders\/|\/private\/|\/tmp\/(?!cc-socks\/0\.sock)/.test(text)) found.push("a temp directory of the recording machine");
  if (standsAlone(user).test(text)) found.push("the local user name");
  if (host && standsAlone(host).test(text)) found.push("the machine name");
  // Covers what the evidence writer redacts: email addresses and
  // token-shaped strings, besides the home paths above.
  if (redact(text) !== text) found.push("an email address, a token-shaped string or a home path");
  if (Buffer.byteLength(text) > MAX_BYTES) found.push(`more than ${MAX_BYTES} bytes`);
  return found;
}

if (isMain(import.meta.url)) {
  const [run, trace, name] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun tests/verify/scrub.mjs <run-directory> <check>/<run> <fixture-name>");
    process.exit(2);
  }
  const { stage } = JSON.parse(readFileSync(join(run, "setup.json"), "utf8"));
  const fixture = scrub(readFileSync(join(run, "traces", `${trace}.jsonl`), "utf8"), stage);
  const found = leaks(fixture);
  if (found.length) {
    console.error(`FAIL: the scrubbed trace still holds ${found.join(", ")}`);
    process.exit(1);
  }
  writeFileSync(join(FIXTURES, `${name}.jsonl`), fixture);
  console.log(`ok: ${name}.jsonl, ${Buffer.byteLength(fixture)} bytes`);
}
