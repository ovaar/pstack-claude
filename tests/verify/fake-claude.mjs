#!/usr/bin/env bun
// Stands in for the CLI where a test drives the whole command: it answers
// --version, and for a session it replays the recorded trace of the flow its
// arguments name, with the stage it was pointed at. The names of the
// variables it was started with go to stderr, which the driver saves.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.332 (Claude Code)");
  process.exit(0);
}
const stage = args[args.indexOf("--plugin-dir") + 1].replace(/\/plugins\/pstack$/, "");
const fixture = args.includes("--input-format") ? "untouched.S3.startup" : "untouched.S2.context";
process.stderr.write(`${Object.keys(process.env).sort().join(" ")}\n`);
process.stdout.write(readFileSync(join(import.meta.dir, "fixtures", `${fixture}.jsonl`), "utf8").replaceAll("<STAGE>", stage));
