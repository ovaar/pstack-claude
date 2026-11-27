#!/usr/bin/env bun
// Stands in for the CLI where a test drives the whole command. It says what
// it is when asked for its version, so no run against it reads PASS. For a
// session it replays the untouched recording of the run it was started for,
// which it reads from the directory setup made for that run,
// <sandbox>/<check>/<run>/cwd, with the stage and the sandbox it was given.
// The names of its variables go into a transcript, which the driver saves.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.332 (stand-in for tests)");
  process.exit(0);
}
const stage = args[args.indexOf("--plugin-dir") + 1].replace(/\/plugins\/pstack$/, "");
const [check, run] = process.cwd().split(sep).slice(-3);
const sandbox = process.cwd().split(sep).slice(0, -3).join(sep);

const transcripts = join(process.env.CLAUDE_CONFIG_DIR, "projects", "stand-in");
mkdirSync(transcripts, { recursive: true });
writeFileSync(join(transcripts, "session.jsonl"), `${JSON.stringify({ type: "stand-in", env: Object.keys(process.env).sort() })}\n`);

const recording = readFileSync(join(import.meta.dir, "fixtures", `untouched.${check}.${run}.jsonl`), "utf8");
process.stdout.write(recording.replaceAll("<STAGE>", stage).replaceAll("<SANDBOX>", sandbox));
