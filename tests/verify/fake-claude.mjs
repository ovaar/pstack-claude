#!/usr/bin/env bun
// Stands in for the CLI where a test drives the whole command. It says what
// it is when asked for its version, so no run against it reads PASS. For a
// session it replays the untouched recording of the run it was started for,
// which it reads from the directory setup made for that run,
// <sandbox>/<check>/<run>/cwd, with the stage and the sandbox it was given.
// The names of its variables go into a transcript, which the driver saves.
// It is told which run it is by what the run's flow lists: the sandbox it
// started in names the run, or the run whose sandbox it shares, and the
// arguments name which of those.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { FLOWS_DIR, loadDir } from "../../tools/verify/paths.mjs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.332 (stand-in for tests)");
  process.exit(0);
}
// `claude auth status`: signed in where the home holds a marker file, which
// is how a test gives the stand-in a login without a real one.
if (args[0] === "auth") {
  const signedIn = existsSync(join(process.env.HOME ?? "", ".stand-in-login"));
  console.log(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? "stand-in" : "none" }));
  process.exit(signedIn ? 0 : 1);
}
const command = args[0] === "plugin";
const target = args.at(-1);
const stage = command ? target.replace(/\/plugins\/pstack$/, "") : args[args.indexOf("--plugin-dir") + 1].replace(/\/plugins\/pstack$/, "");
const [check, lead] = process.cwd().split(sep).slice(-3);
const sandbox = process.cwd().split(sep).slice(0, -3).join(sep);
const started = JSON.stringify(args.slice(args.indexOf("--verbose") + 1));
const flow = (await loadDir(FLOWS_DIR)).find((each) => each.id === check);
const run = flow.runs.filter((each) => (each.share ?? each.name) === lead).find((each) => (command ? each.command : JSON.stringify(each.args ?? []) === started));

const fixtures = join(import.meta.dir, "fixtures");
const named = (text) => text.replaceAll("<STAGE>", stage).replaceAll("<SANDBOX>", sandbox);
// The first line says which variables the session had; a recording of the
// run's transcript, where there is one, follows it. A session signed in as a
// person has no config directory of its own, and leaves none.
if (process.env.CLAUDE_CONFIG_DIR) {
  const transcripts = join(process.env.CLAUDE_CONFIG_DIR, "projects", "stand-in");
  mkdirSync(transcripts, { recursive: true });
  const recordedTranscript = join(fixtures, `untouched.${check}.${run.name}.transcript.jsonl`);
  writeFileSync(join(transcripts, "session.jsonl"), `${JSON.stringify({ type: "stand-in", env: Object.keys(process.env).sort() })}\n${existsSync(recordedTranscript) ? named(readFileSync(recordedTranscript, "utf8")) : ""}`);
}

process.stdout.write(named(readFileSync(join(fixtures, `untouched.${check}.${run.name}.jsonl`), "utf8")));
