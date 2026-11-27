// Turns a trace from a real run into a fixture fit for a public repository.
//
//   bun tests/verify/scrub.mjs <run-directory> <check>/<run> <fixture-name>
//
// The run directory is the one `bun tools/verify.mjs` prints as `evidence:`.
// The stage path becomes <STAGE> and the sessions' directory <SANDBOX>, which
// the tests point at directories of their own, and everything else that
// names this machine or the account that recorded becomes a placeholder: the
// home directory, the user and machine names wherever they stand, email
// addresses, and every session, account or event id, which are renumbered
// under one reserved prefix. A signed-in trace carries more of that than a
// logged-out one, so it also drops what only describes the account's usage
// (rate-limit events) and the CLI's progress noise, and cuts any very long
// text, such as a skill's whole body, to its start. A name that is not
// generic can be added to the list with PSTACK_SCRUB_NAMES, a comma list,
// for what the tool cannot know, such as an organisation's name.
// `leaks` is what tests/verify/fixtures-clean.test.mjs holds every fixture to.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMain } from "../../tools/plugin.mjs";
import { asHost, asUser, redact, thisMachine } from "../../tools/verify/evidence.mjs";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const MAX_BYTES = 64 * 1024;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Every id in a fixture is a placeholder of this shape, numbered in order.
export const PLACEHOLDER = "00000000-0000-4000-8000-";
// The CLI names a project directory after its working directory this way.
const slug = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
const literal = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name inside a longer identifier, such as root in fix-root-causes, names
// nobody. Case does not matter: a trace shows a name as typed or as printed.
const standsAlone = (name) => new RegExp(`(?<![A-Za-z0-9-])${literal(name)}(?![A-Za-z0-9-])`, "i");

// The names of accounts that are words in every recording. They count only
// where they name someone, as redact has it. Every other name counts as a
// whole word anywhere, however short: a short list is the only exception.
const GENERIC = ["user", "claude", "code", "test", "root", "admin", "runner", "sandbox", "local", "ubuntu"];
const narrow = (name) => GENERIC.includes(name.toLowerCase());

// Server-side ids tie a trace to an account and its usage: the API's request
// and message ids, a tool call's id, and the ids of a background agent and a
// run. They are renumbered too, one placeholder per distinct id, so that a
// result still points at its call and a message id still counts as one call.
export const ID_ZEROS = "00000000";
const PREFIXED = /\b(req|msg|toolu)_[A-Za-z0-9]{20,}/g;
const KEYED = /"(?:agent_id|task_id|run_id|agentId)":"([A-Za-z0-9_-]{8,})"/g;
const KEYED_REAL = /"(?:agent_id|task_id|run_id|agentId)":"(?!00000000)[A-Za-z0-9_-]{8,}"/;
const PREFIXED_REAL = /\b(?:req|msg|toolu)_(?!00000000)[A-Za-z0-9]{20,}/;

export function renumber(text) {
  const seen = new Map();
  const number = (id, prefix = "") => seen.get(id) ?? seen.set(id, `${prefix}${ID_ZEROS}${String(seen.size + 1).padStart(12, "0")}`).get(id);
  let out = text.replace(PREFIXED, (id, prefix) => (id.slice(prefix.length + 1).startsWith(ID_ZEROS) ? id : number(id, `${prefix}_`)));
  // A background agent's id also stands in paths and prose, so every
  // occurrence of one found under its key is replaced.
  for (const [, id] of text.matchAll(KEYED)) if (!id.startsWith(ID_ZEROS)) out = out.replaceAll(id, number(id));
  return out;
}

const KEEP = 1200;
const NOISE = ["thinking_tokens", "task_progress"];
// The init event and a hook's response are what the checks read whole.
const WHOLE = (event) => event.type === "system" && ["init", "hook_response", "hook_started"].includes(event.subtype);

const shorten = (value) => {
  if (typeof value === "string") return value.length > KEEP ? `${value.slice(0, KEEP)}... [${value.length - KEEP} more characters left out]` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, shorten(each)]));
  return value;
};

// Line by line, so that a line that is not JSON is kept as it came. A stream
// that carries a second turn repeats its init event, and only the first
// describes the session.
function slim(text) {
  let inits = 0;
  return text
    .split("\n")
    .flatMap((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [line];
      }
      if (event.type === "rate_limit_event" || (event.type === "system" && NOISE.includes(event.subtype))) return [];
      if (event.type === "system" && event.subtype === "init" && (inits += 1) > 1) return [];
      return [JSON.stringify(WHOLE(event) ? event : shorten(event))];
    })
    .join("\n");
}

export function scrub(text, stage, sandbox, machine = thisMachine(), names = []) {
  const ids = new Map();
  // Numbered in order of appearance, so two events that shared an id still do.
  const placeholder = (id) => ids.get(id.toLowerCase()) ?? ids.set(id.toLowerCase(), `${PLACEHOLDER}${String(ids.size + 1).padStart(12, "0")}`).get(id.toLowerCase());
  const named = [machine.user, machine.host, machine.host?.split(".")[0], ...names].filter((name) => name && !narrow(name));
  let out = slim(text)
    .replaceAll(stage, "<STAGE>")
    .replaceAll(sandbox, "<SANDBOX>")
    .replaceAll(slug(sandbox), "-SANDBOX")
    .replaceAll(machine.home, "<HOME>")
    .replaceAll(slug(machine.home), "-HOME")
    .replace(UUID, placeholder)
    .replace(/cc-socks\/\d+\.sock/g, "cc-socks/0.sock")
    // Where the CLI keeps the output of a background agent, under the
    // account's numeric id.
    .replace(/\/(?:private\/)?tmp\/claude-\d+\//g, "<TMP>/");
  for (const name of named) out = out.replace(new RegExp(standsAlone(name).source, "gi"), "<name>");
  out = renumber(out);
  return redact(out, { places: {}, user: machine.user, host: machine.host, tmp: [], home: machine.home });
}

// Over committed fixtures a name counts where it names someone, as redact
// has it, when it is one of the generic words above: the account that runs
// the tests may be called user or claude, and those are words in every
// recording. Any other name counts wherever it stands, whatever its case.
// `strict` is for the one who records, whose own name must not stand
// anywhere in the trace about to be committed.
export function leaks(text, user = thisMachine().user, host = thisMachine().host, { strict = false, names = [] } = {}) {
  const hit = (name, where) => (narrow(name) ? (strict ? standsAlone(name) : where(name)) : standsAlone(name)).test(text);
  const found = [];
  if (text.includes("/Users/") || text.includes("-Users-")) found.push("a /Users/ path");
  if (text.includes("/home/") || text.includes("-home-")) found.push("a /home/ path");
  if (/\/var\/folders\/|\/private\/|\/tmp\/(?!cc-socks\/0\.sock)/.test(text)) found.push("a temp directory of the recording machine");
  if (user && hit(user, asUser)) found.push("the local user name");
  if (host && (hit(host, asHost) || (host.includes(".") && hit(host.split(".")[0], asHost)))) found.push("the machine name");
  if (names.some((name) => standsAlone(name).test(text))) found.push("a name from PSTACK_SCRUB_NAMES");
  // Any id that is not a placeholder is a real one: a session, an account,
  // an organisation, an event.
  if ((text.match(UUID) ?? []).some((id) => !id.startsWith(PLACEHOLDER))) found.push("a UUID that is not a placeholder");
  if (PREFIXED_REAL.test(text) || KEYED_REAL.test(text)) found.push("a server-side id that is not a placeholder");
  // What the evidence writer redacts whatever the machine: email addresses,
  // token-shaped strings and home paths.
  if (redact(text, { user: null, host: null, tmp: [] }) !== text) found.push("an email address, a token-shaped string or a home path");
  if (Buffer.byteLength(text) > MAX_BYTES) found.push(`more than ${MAX_BYTES} bytes`);
  return found;
}

if (isMain(import.meta.url)) {
  const [run, trace, name] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun tests/verify/scrub.mjs <run-directory> <check>/<run> <fixture-name>");
    process.exit(2);
  }
  const extra = (process.env.PSTACK_SCRUB_NAMES ?? "").split(",").map((each) => each.trim()).filter(Boolean);
  const { stage, sandbox } = JSON.parse(readFileSync(join(run, "setup.json"), "utf8"));
  const fixture = scrub(readFileSync(join(run, "traces", `${trace}.jsonl`), "utf8"), stage, sandbox, thisMachine(), extra);
  const found = leaks(fixture, undefined, undefined, { strict: true, names: extra });
  if (found.length) {
    console.error(`FAIL: the scrubbed trace still holds ${found.join(", ")}`);
    process.exit(1);
  }
  writeFileSync(join(FIXTURES, `${name}.jsonl`), fixture);
  console.log(`ok: ${name}.jsonl, ${Buffer.byteLength(fixture)} bytes`);
}
