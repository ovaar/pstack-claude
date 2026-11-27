// What a run writes for people and for a later gate: the verdict line first,
// one row per check, a receipt that lists every check, nothing private.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../tools/verify/check.mjs";
import { markdown, nextRound, prune, receipt, recordRound, redact, writeEvidence } from "../../tools/verify/evidence.mjs";
import { cleanup, ENGINE, evidence, tempDir } from "./harness.mjs";
import { leaks } from "./scrub.mjs";

afterEach(cleanup);

const judge = (edits) => check(evidence(ENGINE, edits), ENGINE.checks);
const brokenHook = { E2: { fixture: "hook-not-executable.S3.startup" } };
const PUBLISHED = ["evidence.md", "evidence.json", "receipt.json"];
// Built at run time so that no scanner reads these lines as a leak.
const token = ["sk", "ant", "api03", "x".repeat(24)].join("-");
const address = ["someone", "example.com"].join("@");

test("evidence.md opens with the verdict line, then what was judged, a row per check and the observations", async () => {
  const lines = markdown(await judge()).split("\n");
  expect(lines.slice(0, 9)).toEqual([
    "PASS surface 2/2 | behavior NOT BUILT | round 1",
    "",
    "- subject_id: fixture",
    "- tree: fixture",
    expect.stringMatching(/^- stage hash: [0-9a-f]{64}$/),
    `- CLI: 2.1.332 at /opt/claude/2.1.332, sha256 ${"c".repeat(64)} (checks verified on 2.1.332)`,
    "- cost: $0",
    "- run: fixture",
    "",
  ]);
  expect(lines.filter((line) => line.startsWith("| E"))).toEqual([
    "| E1 the session reports its plugins | pass | 5 plugins in init; 13 of 13 integrity rules hold |",
    "| E2 the session ran a hook | pass | exit_code 0; 13 of 13 integrity rules hold |",
  ]);
  expect(lines.slice(lines.indexOf("## Observations"))).toEqual(["## Observations", "", "None.", ""]);
});

test("a failed row names each failed assertion with what was seen and wanted", async () => {
  const text = markdown(await judge(brokenHook));
  expect(text.split("\n").find((line) => line.startsWith("| E2 "))).toBe("| E2 the session ran a hook | fail | hook: saw exit_code 126, want exit_code 0 |");
  expect(text).toContain("- E2 startup: hook SessionStart:startup wrote to stderr: /bin/sh: ");
});

test("a stand-in CLI is named under the verdict line", async () => {
  const cli = { path: "/work/fake-claude.mjs", real_path: "/work/fake-claude.mjs", sha256: "d".repeat(64), version: "2.1.332", stand_in: "named by PSTACK_VERIFY_CLAUDE", missing: false, required: false, problem: null };
  const result = await judge({ setup: { cli }, E1: { argv: (argv) => [cli.path, ...argv.slice(1)] }, E2: { argv: (argv) => [cli.path, ...argv.slice(1)] } });
  const lines = markdown(result).split("\n");
  expect(lines[0]).toBe("STAND-IN surface 2/2 | behavior NOT BUILT | round 1");
  expect(lines.slice(5, 7)).toEqual([
    `- CLI: 2.1.332 at /work/fake-claude.mjs, sha256 ${"d".repeat(64)} (checks verified on 2.1.332)`,
    "- CLI stand-in: named by PSTACK_VERIFY_CLAUDE. No verdict on the claude a user has.",
  ]);
  expect(receipt(result)).toMatchObject({ verdict: "STAND-IN", cli_stand_in: "named by PSTACK_VERIFY_CLAUDE", cli_path: cli.path, cli_sha256: cli.sha256 });
});

test("the receipt lists every check with its own verdict, so a partial run cannot pass for a full one", async () => {
  const partial = receipt(await judge({ setup: { selection: { tier: "all", flow: "E1" }, selected: ["E1"] } }));
  expect(partial).toMatchObject({
    subject_id: "fixture",
    tree_id: "fixture",
    verdict: "PARTIAL",
    line: "PARTIAL surface 1/2 | behavior NOT BUILT | round 1",
    selection: { tier: "all", flow: "E1" },
    cli_version: "2.1.332",
    cli_path: "/opt/claude/2.1.332",
    cost_usd: 0,
    authority: expect.stringMatching(/^none: /),
  });
  expect(partial.checks).toEqual([
    { id: "E1", tier: "surface", verdict: "pass" },
    { id: "E2", tier: "surface", verdict: "skipped", reason: "not selected" },
  ]);
  expect(partial).not.toHaveProperty("cli_stand_in");

  const failing = receipt(await judge(brokenHook));
  expect(failing.verdict).toBe("FAIL");
  expect(failing.checks[1]).toEqual({ id: "E2", tier: "surface", verdict: "fail", failed: ["E2.hook"] });
});

describe("redaction", () => {
  const nobody = { home: "/srv/people/ada", user: "ada", host: "ada-box", tmp: ["/private/var/folders/ab/cd/T", "/var/folders/ab/cd/T"] };

  test("home paths, email addresses and token-shaped strings go, digests and plugin sources stay", () => {
    expect(redact("/Users/someone/work and /home/runner/work and C:\\Users\\someone\\work", nobody)).toBe("~/work and ~/work and ~\\work");
    expect(redact("in /srv/people/ada/checkout", nobody)).toBe("in ~/checkout");
    expect(redact(`mail ${address} now`, nobody)).toBe("mail <email> now");
    expect(redact(`key ${token}.`, nobody)).toBe("key <token>.");
    const kept = "stdout sha256 39dc6bebcc7b50e6add4b28d470b2faf9f34391fad1bf847039bbe76f26e84e4 from pstack@inline and cc-plugin-privacy@builtin";
    expect(redact(kept, nobody)).toBe(kept);
  });

  test("the run's own directories are named, and any other temp path is cut at the temp directory", () => {
    const places = { "/srv/people/ada/repo/.git/pstack-verify/runs/r1/stage": "<stage>", "/private/var/folders/ab/cd/T/pstack-verify-x1": "<sandbox>" };
    const text = "sh: /srv/people/ada/repo/.git/pstack-verify/runs/r1/stage/plugins/pstack/hooks/x.sh in /private/var/folders/ab/cd/T/pstack-verify-x1/S3/startup/cwd, log /var/folders/ab/cd/T/other.log";
    expect(redact(text, { ...nobody, places })).toBe("sh: <stage>/plugins/pstack/hooks/x.sh in <sandbox>/S3/startup/cwd, log <tmp>/other.log");
    expect(redact("the stage is /srv/people/ada/repo/.git/pstack-verify/runs/r1/stage.", { ...nobody, places })).toBe("the stage is <stage>.");
    expect(redact("/tmpfs/x and /tmp/x and /tmp", { ...nobody, tmp: ["/tmp"] })).toBe("/tmpfs/x and <tmp>/x and <tmp>");
  });

  // A session directory under a temp directory carries the home path with
  // dashes for slashes.
  test("a home path written with dashes loses its name", () => {
    expect(redact("/opt/scratch/-Users-ada-work-project/stage and projects/-home-ada-repo/memory", nobody)).toBe("/opt/scratch/-~-work-project/stage and projects/-~-repo/memory");
  });

  test("the user and machine names go where they name someone, and stay where they are words", () => {
    expect(redact("/Volumes/ada/x and ada@ada-box:repo.git", nobody)).toBe("/Volumes/<user>/x and <user>@<host>:repo.git");
    const words = '{"type":"user","skill":"pstack:principle-fix-root-causes","agent":"claude"}';
    for (const user of ["user", "root", "claude"]) expect(redact(words, { ...nobody, user, host: "claude" })).toBe(words);
  });

  test("the three written files hold no path, name or address of this machine", async () => {
    const stderr = (stage) => `/bin/sh: ${stage}/plugins/pstack/hooks/x.sh: denied in /Users/someone/project, ask ${address}\n`;
    const dir = evidence(ENGINE, { ...brokenHook, E1: { events: (events) => void (events.find((event) => event.subtype === "hook_response").stderr = stderr(events.find((event) => event.subtype === "init").plugins[0].path.replace("/plugins/pstack", ""))) } });
    writeEvidence(dir, await check(dir, ENGINE.checks));
    for (const file of PUBLISHED) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(leaks(text)).toEqual([]);
      expect(text).not.toContain(dir);
      expect(text).not.toContain(address);
    }
    const report = readFileSync(join(dir, "evidence.md"), "utf8");
    expect(report).toContain("- E1 context: hook SessionStart:startup wrote to stderr: /bin/sh: <stage>/plugins/pstack/hooks/x.sh: denied in ~/project, ask <email>");
    expect(readFileSync(join(dir, "evidence.json"), "utf8")).toContain('"saw": "cwd <sandbox>/S2/context/cwd"');
    expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).checks[1].failed).toEqual(["E2.hook"]);
  });
});

// The run's receipt is what a gate reads. A rerun of the checker over
// evidence that was edited since must not be able to replace it.
test("a rerun of the checker is written beside the run's files, never over them", async () => {
  const dir = evidence(ENGINE, brokenHook);
  writeEvidence(dir, await check(dir, ENGINE.checks));
  const first = PUBLISHED.map((file) => readFileSync(join(dir, file), "utf8"));

  const rechecked = { ...(await check(dir, ENGINE.checks)), rechecked_at: "2026-11-27T09:00:00.000Z" };
  const report = writeEvidence(dir, rechecked);
  expect(PUBLISHED.map((file) => readFileSync(join(dir, file), "utf8"))).toEqual(first);
  expect(readdirSync(dir).filter((file) => file.includes("recheck")).sort()).toEqual(["evidence.recheck.json", "evidence.recheck.md", "receipt.recheck.json"]);
  expect(readFileSync(join(dir, "evidence.recheck.md"), "utf8")).toBe(report);
  expect(report).toContain("- rechecked: 2026-11-27T09:00:00.000Z");
  expect(JSON.parse(readFileSync(join(dir, "receipt.recheck.json"), "utf8"))).toMatchObject({ verdict: "FAIL", rechecked_at: "2026-11-27T09:00:00.000Z" });
});

describe("rounds", () => {
  const ended = (verdict, ...ids) => ({ verdict, run: "r", subject_id: "s", checks: ids.map((id) => ({ id, verdict: verdict === "FAIL" && id === "S3" ? "fail" : "pass", failed: verdict === "FAIL" && id === "S3" ? ["S3.exit-code"] : [] })) });
  const rounds = (root) => JSON.parse(readFileSync(join(root, "rounds.json"), "utf8"));

  test("a round counts the failed runs since the last pass", () => {
    const root = tempDir();
    expect(nextRound(root)).toBe(1);
    recordRound(root, ended("FAIL", "S2", "S3"));
    expect(nextRound(root)).toBe(2);
    recordRound(root, ended("FAIL", "S2", "S3"));
    expect(nextRound(root)).toBe(3);
    expect(rounds(root)).toEqual([
      { run: "r", subject_id: "s", checks: ["S2", "S3"], failed: ["S3.exit-code"] },
      { run: "r", subject_id: "s", checks: ["S2", "S3"], failed: ["S3.exit-code"] },
    ]);
    expect(recordRound(root, ended("PASS", "S2", "S3"))).toEqual([]);
    expect(nextRound(root)).toBe(1);
  });

  test.each([["SKIPPED"], ["PARTIAL"], ["STAND-IN"]])("a %s run leaves the count as it was", (verdict) => {
    const root = tempDir();
    recordRound(root, ended("FAIL", "S2", "S3"));
    recordRound(root, ended(verdict, "S2", "S3"));
    expect(nextRound(root)).toBe(2);
  });

  // A check file and its flow deleted together make every remaining check
  // pass, which is how a failed round would otherwise be cleared.
  test("a pass that holds fewer checks than a failed round does not start the count over", () => {
    const root = tempDir();
    recordRound(root, ended("FAIL", "S2", "S3"));
    expect(recordRound(root, ended("PASS", "S2"))).toEqual(["S3"]);
    expect(nextRound(root)).toBe(2);
    expect(recordRound(root, ended("PASS", "S2", "S3", "S4"))).toEqual([]);
    expect(nextRound(root)).toBe(1);
  });
});

test("the last five runs are kept, each with its stage, and older ones are dropped", () => {
  const root = tempDir();
  const runs = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `20261126T10000${name}`);
  for (const run of runs) mkdirSync(join(root, "runs", run, "stage"), { recursive: true });
  prune(root);
  expect(readdirSync(join(root, "runs")).sort()).toEqual(runs.slice(2));
  expect(existsSync(join(root, "runs", runs[6], "stage"))).toBe(true);
});
