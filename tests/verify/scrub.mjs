// Turns a trace from a real run into a fixture fit for a public repository.
//
//   bun tests/verify/scrub.mjs <run-directory> <check>/<run> <fixture-name> [transcript|reduced]
//
// The run directory is the one `bun tools/verify.mjs` prints as `evidence:`.
// The stage path becomes <STAGE> and the sessions' directory <SANDBOX>, which
// the tests point at directories of their own, and everything else that
// names this machine becomes a placeholder. A subcommand's one JSON document
// is kept as a single line, a stream that repeats its init event keeps the
// first, and with `transcript` the session's transcript is reduced to the user
// lines and the records of an unknown command, each user line to the first
// line of each of its text blocks: a skill's own text is not a fixture. With
// `reduced` the stream of a run that types many messages keeps of each
// assistant and result event only what trace.mjs reads, so that sixty-nine
// exchanges fit in a fixture.
// `leaks` is what
// tests/verify/fixtures-clean.test.mjs holds every fixture to.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMain } from "../../tools/plugin.mjs";
import { asHost, asUser, redact, thisMachine } from "../../tools/verify/evidence.mjs";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const MAX_BYTES = 64 * 1024;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// The CLI names a project directory after its working directory this way.
const slug = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
// A name inside a longer identifier, such as root in fix-root-causes, names
// nobody.
const standsAlone = (name) => new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`);

export function scrub(text, stage, sandbox) {
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

// Over committed fixtures a name counts where it names someone, as redact
// has it: the account that runs the tests may be called user or claude, and
// those are words in every recording. `strict` is for the one who records,
// whose own name must not stand anywhere in the trace about to be committed.
export function leaks(text, user = thisMachine().user, host = thisMachine().host, { strict = false } = {}) {
  const names = (name, where) => (strict ? standsAlone(name) : where(name)).test(text);
  const found = [];
  if (text.includes("/Users/") || text.includes("-Users-")) found.push("a /Users/ path");
  if (text.includes("/home/") || text.includes("-home-")) found.push("a /home/ path");
  if (/\/var\/folders\/|\/private\/|\/tmp\/(?!cc-socks\/0\.sock)/.test(text)) found.push("a temp directory of the recording machine");
  if (user && names(user, asUser)) found.push("the local user name");
  if (host && names(host, asHost)) found.push("the machine name");
  // What the evidence writer redacts whatever the machine: email addresses,
  // token-shaped strings and home paths.
  if (redact(text, { user: null, host: null, tmp: [] }) !== text) found.push("an email address, a token-shaped string or a home path");
  if (Buffer.byteLength(text) > MAX_BYTES) found.push(`more than ${MAX_BYTES} bytes`);
  return found;
}

// The output of `claude plugin validate --json` is one pretty-printed
// document; a fixture is one record to a line.
export function compact(text) {
  try {
    const document = JSON.parse(text);
    if (document !== null && typeof document === "object" && !Array.isArray(document)) return `${JSON.stringify(document)}\n`;
  } catch {}
  return text;
}

export function firstInit(text) {
  let seen = false;
  return text
    .split("\n")
    .filter((line) => {
      let init = false;
      try {
        const event = JSON.parse(line);
        init = event.type === "system" && event.subtype === "init";
      } catch {}
      if (init && seen) return false;
      seen ||= init;
      return true;
    })
    .join("\n");
}

// What trace.mjs reads of an assistant and a result event, and nothing else:
// the model, the tool uses, and the fields of the result. What a model wrote
// is not read, so it is not kept.
// The events that carry nothing a check reads are the bulk of a long stream.
export function reduceStream(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line);
      if (event.type === "assistant") return { type: "assistant", message: { model: event.message?.model, content: (event.message?.content ?? []).filter((block) => block.type === "tool_use") } };
      if (event.type !== "result") return event;
      const { type, subtype, is_error, total_cost_usd, num_turns, permission_denials, result } = event;
      const by_type = event.subagent_stats?.by_type;
      return { type, subtype, is_error, total_cost_usd, num_turns, modelUsage: Object.fromEntries(Object.keys(event.modelUsage ?? {}).map((model) => [model, {}])), permission_denials, ...(by_type ? { subagent_stats: { by_type } } : {}), result };
    })
    .map((event) => `${JSON.stringify(event)}\n`)
    .join("");
}

const head = (text) => text.split("\n")[0];

export function reduceTranscript(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === "user" || record.attachment?.type === "unknown_command_fallback")
    .map((record) => {
      if (record.type !== "user") return { type: record.type, attachment: { type: record.attachment.type } };
      const { content } = record.message;
      const reduced = typeof content === "string" ? content : content.map((block) => (block.type === "text" ? { type: "text", text: head(block.text) } : { type: block.type }));
      return { type: "user", ...(record.isMeta ? { isMeta: true } : {}), message: { role: "user", content: reduced } };
    })
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
}

if (isMain(import.meta.url)) {
  const [run, trace, name, transcript] = process.argv.slice(2);
  if (!name || (transcript !== undefined && !["transcript", "reduced"].includes(transcript))) {
    console.error("usage: bun tests/verify/scrub.mjs <run-directory> <check>/<run> <fixture-name> [transcript|reduced]");
    process.exit(2);
  }
  const { stage, sandbox } = JSON.parse(readFileSync(join(run, "setup.json"), "utf8"));
  const read = readFileSync(join(run, "traces", transcript === "transcript" ? `${trace}.transcript.jsonl` : `${trace}.jsonl`), "utf8");
  const kept = transcript === "transcript" ? reduceTranscript(read) : transcript === "reduced" ? reduceStream(firstInit(read)) : firstInit(compact(read));
  const fixture = scrub(kept, stage, sandbox);
  const file = transcript === "transcript" ? `${name}.transcript.jsonl` : `${name}.jsonl`;
  const found = leaks(fixture, undefined, undefined, { strict: true });
  if (found.length) {
    console.error(`FAIL: the scrubbed trace still holds ${found.join(", ")}`);
    process.exit(1);
  }
  writeFileSync(join(FIXTURES, file), fixture);
  console.log(`ok: ${file}, ${Buffer.byteLength(fixture)} bytes`);
}
