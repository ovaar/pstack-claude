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

async function session(run, { cli, plugin, out }) {
  const argv = [cli, ...baseArgs(plugin), ...(run.args ?? [])];
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
  const transcript = transcripts(run.config);
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

export async function drive(runs, { cli, plugin, out, jobs = 2 }) {
  const queue = [...runs];
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) await session(run, { cli, plugin, out });
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}
