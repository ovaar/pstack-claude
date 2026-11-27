// The surface workflow must install the CLI the verifier was verified on, use
// the bun ci.yml uses, and name every action by commit. Each rule is checked
// against the parsed workflow, and the install step is also run against a
// stub npm to see which version it asks for.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const behavior = Bun.YAML.parse(read(".github/workflows/behavior.yml"));
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml"));
const pin = JSON.parse(read("tools/verify/cli-pin.json"));

const stepsOf = (workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps);
const bunVersions = (workflow) => [...new Set(stepsOf(workflow).filter((step) => step.uses?.startsWith("oven-sh/setup-bun@")).map((step) => step.with["bun-version"]))];

const CLI = /@anthropic-ai\/claude-code(?:@([^\s"']+))?/g;
const reads = (run) => /\bjq\b[^\n]*tools\/verify\/cli-pin\.json/.test(run);

// The problems one workflow has with its CLI install, as plain strings.
function cliProblems(workflow, verified) {
  const found = stepsOf(workflow).flatMap((step) => [...(step.run ?? "").matchAll(CLI)].map(([, version]) => ({ step, version })));
  if (!found.length) return ["no step installs the Claude Code CLI"];
  return found.flatMap(({ step, version }) => {
    if (version === undefined) return ["the CLI is installed with no version"];
    if (version.startsWith("$")) return reads(step.run) ? [] : [`the CLI version ${version} is not read from cli-pin.json`];
    return version === verified ? [] : [`the CLI is pinned to ${version}, and cli-pin.json verified ${verified}`];
  });
}

describe("the Claude Code CLI version", () => {
  test("is the one cli-pin.json verified, or is read from it", () => {
    expect(cliProblems(behavior, pin.verified)).toEqual([]);
  });

  test("a version typed into the install line is caught", () => {
    const edited = structuredClone(behavior);
    const step = stepsOf(edited).find((each) => each.run?.includes("npm install"));
    step.run = step.run.replace('claude-code@$version"', 'claude-code@2.1.0"');
    expect(cliProblems(edited, pin.verified)).toEqual([`the CLI is pinned to 2.1.0, and cli-pin.json verified ${pin.verified}`]);
  });

  test("an install with no version, and no install at all, are caught", () => {
    const bare = structuredClone(behavior);
    stepsOf(bare).find((each) => each.run?.includes("npm install")).run = "npm install -g @anthropic-ai/claude-code";
    expect(cliProblems(bare, pin.verified)).toEqual(["the CLI is installed with no version"]);
    expect(cliProblems({ jobs: { surface: { steps: [{ run: "true" }] } } }, pin.verified)).toEqual(["no step installs the Claude Code CLI"]);
  });
});

describe("the bun version", () => {
  test("is the one ci.yml uses", () => {
    expect(bunVersions(ci)).toHaveLength(1);
    expect(bunVersions(behavior)).toEqual(bunVersions(ci));
  });
});

describe("every action", () => {
  test("is pinned to a 40-character commit", () => {
    const uses = stepsOf(behavior).filter((step) => step.uses).map((step) => step.uses);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((name) => !/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(name))).toEqual([]);
  });

  test("checkout and setup-bun use the commits ci.yml uses", () => {
    const named = (workflow, prefix) => [...new Set(stepsOf(workflow).filter((step) => step.uses?.startsWith(prefix)).map((step) => step.uses))];
    for (const prefix of ["actions/checkout@", "oven-sh/setup-bun@"]) expect(named(behavior, prefix)).toEqual(named(ci, prefix));
  });
});

// The install step runs under `bash -e` with a stub npm that records its
// arguments, and a stub claude, in a checkout holding only a cli-pin.json.
describe.skipIf(!Bun.which("jq"))("the install step", () => {
  const step = stepsOf(behavior).find((each) => each.run?.includes("npm install"));

  function run(pinFile) {
    const dir = mkdtempSync(join(tmpdir(), "pstack-cli-pin-"));
    try {
      mkdirSync(join(dir, "tools/verify"), { recursive: true });
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "tools/verify/cli-pin.json"), pinFile);
      writeFileSync(join(dir, "step.sh"), step.run);
      writeFileSync(join(dir, "bin/npm"), '#!/bin/bash\necho "$*" >> "$CALLS"\n', { mode: 0o755 });
      writeFileSync(join(dir, "bin/claude"), "#!/bin/bash\necho stub\n", { mode: 0o755 });
      writeFileSync(join(dir, "calls"), "");
      const { status } = spawnSync("bash", ["-e", "step.sh"], { cwd: dir, env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, CALLS: join(dir, "calls") }, encoding: "utf8" });
      return { passed: status === 0, calls: readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("installs the version the file names, whatever it is", () => {
    expect(run(JSON.stringify({ verified: pin.verified, minimum: pin.minimum }))).toEqual({ passed: true, calls: [`install -g @anthropic-ai/claude-code@${pin.verified}`] });
    expect(run(JSON.stringify({ verified: "9.8.7", minimum: "9.8.7" }))).toEqual({ passed: true, calls: ["install -g @anthropic-ai/claude-code@9.8.7"] });
  });

  test("fails, with no install, when the file names no usable version", () => {
    for (const file of [JSON.stringify({ minimum: "1.0.0" }), JSON.stringify({ verified: "latest" }), JSON.stringify({ verified: "1.2.3 --registry=x" })]) {
      expect(run(file)).toEqual({ passed: false, calls: [] });
    }
  });
});
