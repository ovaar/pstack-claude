// The driver, the second role: the only module that starts a Claude Code
// session. It runs what a flow file lists against the stage, the way a user
// loads the plugin, and saves what came back. It reads no event, imports
// nothing from checks/ and returns no verdict: judging is the checker's job,
// and a driver that judged could let its own runs pass.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `--bare` and `--safe-mode` are never added: both skip plugin hooks, so they
// do not show the surface a user meets.
const baseArgs = (plugin) => ["-p", "--plugin-dir", plugin, "--model", "haiku", "--output-format", "stream-json", "--verbose"];

// A flow may start one subcommand of the CLI in place of a session, and only a
// read-only one that calls no model: the plugin validator. The checker holds
// its own copy of the argument list a flow's run must have, so a command added
// here alone fails its argv rule.
const COMMANDS = [["plugin", "validate"]];
const PLACES = (plugin, stage) => ({ "<plugin>": plugin, "<stage>": stage });

function argvOf(run, { cli, plugin, stage }) {
  if (!run.command) return [cli, ...baseArgs(plugin), ...(run.args ?? [])];
  if (!COMMANDS.some((allowed) => allowed.every((word, at) => run.command[at] === word))) throw new Error(`the driver starts no subcommand like ${JSON.stringify(run.command)}`);
  const places = PLACES(plugin, stage);
  return [cli, ...run.command.map((word) => places[word] ?? word)];
}

// A fresh config directory holds only this run's sessions, so every
// transcript in it belongs to the run.
function transcripts(config) {
  const projects = join(config, "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects)
    .sort()
    .flatMap((project) =>
      readdirSync(join(projects, project))
        .filter((file) => file.endsWith(".jsonl"))
        .sort()
        .map((file) => readFileSync(join(projects, project, file))),
    );
}

async function session(run, { cli, plugin, stage, out }) {
  const argv = argvOf(run, { cli, plugin, stage });
  const started = Date.now();
  const child = spawn(cli, argv.slice(1), { cwd: run.cwd, env: run.env });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  // A CLI that exits before it reads its input must not take the driver down.
  child.stdin.on("error", () => {});
  child.stdin.end(run.stdin ?? "");
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, run.timeoutMs ?? 60_000);
  const ended = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  const trace = Buffer.concat(stdout);
  const dir = join(out, run.id);
  mkdirSync(dir, { recursive: true });
  const file = (suffix) => join(dir, `${run.name}${suffix}`);
  writeFileSync(file(".jsonl"), trace);
  writeFileSync(file(".stderr"), Buffer.concat(stderr));
  // A session signed in as the person who runs the verifier has the real
  // config directory, which holds sessions that are not this run's.
  const transcript = run.config ? transcripts(run.config) : [];
  if (transcript.length) writeFileSync(file(".transcript.jsonl"), Buffer.concat(transcript));
  const sidecar = {
    argv,
    env: Object.keys(run.env).sort(),
    cwd: run.cwd,
    exit_code: ended.code ?? null,
    signal: ended.signal ?? null,
    spawn_error: ended.error ?? null,
    timed_out: timedOut,
    duration_ms: Date.now() - started,
    trace_sha256: createHash("sha256").update(trace).digest("hex"),
  };
  writeFileSync(file(".sidecar.json"), `${JSON.stringify(sidecar, null, 2)}\n`);
}

// Runs that share a sandbox go one after the other, in the order listed: a
// resumed session needs the conversation the run before it left. A sandbox is
// told by its working directory, which a model-tier run signed in as the
// person has of its own even though it has no config directory.
export async function drive(runs, { cli, stage, plugin, out, jobs = 2 }) {
  const groups = new Map();
  for (const run of runs) groups.set(run.cwd, [...(groups.get(run.cwd) ?? []), run]);
  const queue = [...groups.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const run of group) await session(run, { cli, plugin, stage, out });
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}
