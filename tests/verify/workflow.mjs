// Shared by the tests of .github/workflows/behavior.yml: the parsed workflow,
// and a way to run one step's body under bash as the runner would, with a
// stub bun that prints a chosen verdict for tools/verify.mjs and runs the real
// bun for everything else, such as tools/verify/verdict.mjs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const TEXT = readFileSync(join(ROOT, ".github/workflows/behavior.yml"), "utf8");
export const workflow = Bun.YAML.parse(TEXT);
export const stepNamed = (job, name) => workflow.jobs[job].steps.find((step) => step.name === name);

// Runs `step.run` under `bash -eo pipefail`, as the runner does, from the
// repository root. `verdict` and `exit` are what tools/verify.mjs prints and
// returns; every bun call is logged. `before(dir)` prepares RUNNER_TEMP and
// `after(dir)` reads it once the step is done. Returns the exit, the output,
// the files the runner would read back, and what `after` returned.
export function runStep(step, { env = {}, verdict = "", exit = 0, before, after } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pstack-workflow-")));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "step.sh"), step.run);
    writeFileSync(join(dir, "calls"), "");
    writeFileSync(join(dir, "output"), "");
    writeFileSync(join(dir, "summary"), "");
    writeFileSync(
      join(dir, "bin/bun"),
      `#!/bin/bash\necho "$*" >> "${join(dir, "calls")}"\nif [ "$1" = tools/verify.mjs ]; then\n  printf '%s\\n' "$VERDICT" "- run: 1"\n  exit ${exit}\nfi\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    before?.(dir);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
      cwd: ROOT,
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"), VERDICT: verdict, ...env },
      encoding: "utf8",
    });
    const read = (file) => readFileSync(join(dir, file), "utf8");
    return { status: result.status, passed: result.status === 0, stdout: result.stdout, stderr: result.stderr, output: read("output"), summary: read("summary"), calls: read("calls").split("\n").filter(Boolean), after: after?.(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
