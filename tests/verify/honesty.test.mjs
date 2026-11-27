// The honesty command and the planted mistakes it runs. The committed mistakes
// are held to their shape and to the ratchet here; the command itself is
// tested offline against the stand-in CLI, which replays untouched recordings
// and so catches only what a check can tell from the tree alone. What the real
// CLI catches is the full run's to show: bun tools/verify.mjs honesty.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { atHead, atRef, judge, loadMutants, MUTANTS_DIR, plant, PlantDidNotApply, problem, ratchet } from "../../tools/honesty.mjs";
import { CHECKS_DIR, listDir } from "../../tools/verify/paths.mjs";
import { cleanup, commitAll, git, productRepo, tempDir } from "./harness.mjs";

let tmp;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(cleanup);

const ROOT = join(import.meta.dir, "../..");
const VERIFY = join(ROOT, "tools/verify.mjs");
const FAKE_CLI = join(import.meta.dir, "fake-claude.mjs");
const PATH = [dirname(process.execPath), ...process.env.PATH.split(delimiter).filter((dir) => !existsSync(join(dir, "claude")))].join(delimiter);
const LONG = 120_000;
const MANDATE = "plugins/pstack/hooks/session-start-context.md";

const committed = loadMutants();
const checkIds = listDir(CHECKS_DIR).map((entry) => entry.id);
const escapes = committed.filter((mutant) => mutant.known_escape);

describe("the committed planted mistakes", () => {
  test("hold the shape the command reads", () => {
    expect(committed.length).toBeGreaterThan(0);
    expect(readdirSync(MUTANTS_DIR).filter((file) => !file.endsWith(".json"))).toEqual([]);
  });

  test("every check in checks/ is the expected catcher of at least one", () => {
    const caught = new Set(committed.filter((mutant) => mutant.catches).map((mutant) => mutant.catches.check));
    expect(checkIds.filter((id) => !caught.has(id))).toEqual([]);
  });

  test("name only checks that exist as catchers, and checks that do not exist yet as future catchers", () => {
    expect(committed.filter((mutant) => mutant.catches && !checkIds.includes(mutant.catches.check)).map((mutant) => mutant.id)).toEqual([]);
    // A future check that now exists is a blind spot closed: the file moves to catches.
    expect(escapes.filter((mutant) => checkIds.includes(mutant.known_escape.future_check)).map((mutant) => mutant.id)).toEqual([]);
  });

  // A check that fails an assertion nothing plants a mistake for could be
  // weakened without the table changing. The doctored-trace tests would
  // notice; this keeps the planted mistakes from depending on them.
  test("every assertion of every check is named by at least one", () => {
    const named = new Set(committed.filter((mutant) => mutant.catches?.assertion).map((mutant) => `${mutant.catches.check}.${mutant.catches.assertion}`));
    const unnamed = [];
    for (const { id, file } of listDir(CHECKS_DIR)) {
      for (const [, assertion] of readFileSync(join(CHECKS_DIR, file), "utf8").matchAll(/\bid: "([a-z0-9-]+)"/g)) if (!named.has(`${id}.${assertion}`)) unnamed.push(`${id}.${assertion}`);
    }
    expect(unnamed).toEqual([]);
  });

  // The number of known escapes only goes down. The count is committed, so
  // adding an escape means raising it in a diff a reviewer sees, and fixing
  // one means lowering it in the same commit.
  test("know no more escapes than the baseline, and the baseline is as low as they are", () => {
    const baseline = JSON.parse(readFileSync(join(MUTANTS_DIR, "../baseline.json"), "utf8"));
    expect(escapes.length).toBeLessThanOrEqual(baseline.known_escapes);
    expect(baseline.ids).toEqual(escapes.map((mutant) => mutant.id).sort());
    expect(baseline.known_escapes).toBe(baseline.ids.length);
  });

  test("seed the mistakes proven on the core and the escapes found on it", () => {
    const ids = committed.map((mutant) => mutant.id);
    for (const id of ["hook-not-executable", "mandate-deleted", "mandate-emptied", "mandate-names-unloaded-skill", "dependency-restored", "skill-without-description", "stray-commands-directory"]) {
      expect(committed.find((mutant) => mutant.id === id)?.catches).toBeDefined();
    }
    for (const id of ["hooks-json-deleted", "hook-stdout-extra", "hook-stderr-noise", "hook-fails-after-printing", "hook-registered-twice", "hook-registered-by-manifest"]) {
      expect(committed.find((mutant) => mutant.id === id)?.catches).toBeDefined();
    }
    for (const id of ["sessionstart-matcher-narrowed", "marketplace-json-broken", "agents-directory-removed", "skill-unnamed-by-mandate-removed"]) {
      expect(ids).toContain(id);
      expect(escapes.map((mutant) => mutant.id)).toContain(id);
    }
  });
});

describe("a mutant file is refused unless it is exact", () => {
  const good = { id: "x", description: "d", edits: [{ op: "delete", path: "plugins/pstack/a" }], catches: { check: "S3" } };
  const bad = [
    ["is not an object", [1]],
    ["has unknown keys extra", { ...good, extra: 1 }],
    ['has id "y", want x', { ...good, id: "y" }],
    ["has no description", { ...good, description: " " }],
    ["has no edits", { ...good, edits: [] }],
    ['has an edit with op "touch"', { ...good, edits: [{ op: "touch", path: "plugins/pstack/a" }] }],
    ["has a replace edit with keys find, path, wth, want path, find, with", { ...good, edits: [{ op: "replace", path: "plugins/pstack/a", find: "a", wth: "b" }] }],
    ["edits tools/verify/check.mjs, which is not under plugins/pstack, .claude-plugin, VERSION", { ...good, edits: [{ op: "delete", path: "tools/verify/check.mjs" }] }],
    ["edits plugins/pstack/../../x, which is not under plugins/pstack, .claude-plugin, VERSION", { ...good, edits: [{ op: "delete", path: "plugins/pstack/../../x" }] }],
    ["has chmod mode 8, want three octal digits", { ...good, edits: [{ op: "chmod", path: "plugins/pstack/a", mode: "8" }] }],
    ["has to hold exactly one of catches and known_escape", { ...good, catches: undefined }],
    ["has to hold exactly one of catches and known_escape", { ...good, known_escape: { reason: "r", future_check: "S9" } }],
    ["has a known_escape without a reason and a future_check", { ...good, catches: undefined, known_escape: { reason: "r" } }],
  ];

  test("the exact one passes", () => expect(problem(good, "x.json")).toBeNull());
  test.each(bad)("%s", (wrong, mutant) => {
    expect(problem(mutant, "x.json")).toBe(wrong);
  });
});

// The verdict of one mutant from a run's structured result.
describe("judging a run", () => {
  const run = (...checks) => ({ checks: checks.map(([id, verdict, extra]) => ({ id, verdict, failed: [], ...extra })) });
  const catches = (assertion) => ({ id: "m", catches: { check: "S3", ...(assertion ? { assertion } : {}) } });
  const unseen = ["S3", "unobservable", { reason: "a hook_response named SessionStart:startup is missing" }];

  test("a check that cannot see its evidence has caught a mistake that names no assertion", () => {
    expect(judge(catches(), run(unseen))).toEqual({ status: "caught", note: "S3 unobservable: a hook_response named SessionStart:startup is missing" });
  });

  test("and has not caught one that names an assertion, without blaming itself for it", () => {
    expect(judge(catches("stdout"), run(unseen))).toEqual({ status: "escaped", note: "S3 unobservable" });
    expect(judge(catches("stdout"), run(unseen, ["S2", "fail", { failed: ["S2.skills"] }]))).toEqual({ status: "escaped", note: "S3 unobservable, other failures: S2" });
  });

  test("a known escape the verifier fails by unobservable is a blind spot closed", () => {
    expect(judge({ id: "m", known_escape: { reason: "r", future_check: "S9" } }, run(unseen)).status).toBe("promote");
  });

  test("a pass is an escape, a failure on the named assertion is a catch", () => {
    expect(judge(catches(), run(["S3", "pass"])).status).toBe("escaped");
    expect(judge(catches("stdout"), run(["S3", "fail", { failed: ["S3.stdout"] }])).status).toBe("caught");
  });
});

describe("the ratchet against a base", () => {
  const caught = (id, check = "S3", assertion) => ({ id, description: "d", edits: [{ op: "delete", path: "plugins/pstack/a" }], catches: { check, ...(assertion ? { assertion } : {}) } });
  const escaping = (id) => ({ id, description: "d", edits: [{ op: "delete", path: "plugins/pstack/a" }], known_escape: { reason: "r", future_check: "S9" } });
  const state = (...mutants) => {
    const ids = mutants.filter((mutant) => mutant.known_escape).map((mutant) => mutant.id).sort();
    return { baseline: { known_escapes: ids.length, ids }, mutants };
  };
  const base = state(caught("a", "S3", "stdout"), caught("b"), escaping("e"));

  test("the same files, or fewer escapes, pass", () => {
    expect(ratchet(base, base)).toEqual([]);
    expect(ratchet(base, state(caught("a", "S3", "stdout"), caught("b"), caught("e")))).toEqual([]);
    expect(ratchet(base, state(caught("a", "S3", "stdout"), caught("b")))).toEqual([]);
    expect(ratchet(null, base)).toEqual([]);
  });

  test("a new known escape fails, and so does a baseline raised to match", () => {
    const head = state(caught("a", "S3", "stdout"), caught("b"), escaping("e"), escaping("f"));
    expect(ratchet(base, head)).toEqual(["baseline.json raises the known escapes from 1 to 2", "2 known escapes where the base has 1"]);
  });

  test("a catch that is gone, turned into an escape or pointed at another check fails", () => {
    expect(ratchet(base, state(caught("a", "S3", "stdout"), escaping("e")))).toEqual(["b caught by S3 on the base, and is gone"]);
    expect(ratchet(base, state(escaping("a"), caught("b"), escaping("e")))).toContain("a caught by S3.stdout on the base, and is now a known escape");
    expect(ratchet(base, state(caught("a", "S2", "stdout"), caught("b"), escaping("e")))).toEqual(["a expected S3.stdout on the base, and S2.stdout now"]);
    expect(ratchet(base, state(caught("a", "S3", "stderr"), caught("b"), escaping("e")))).toEqual(["a expected S3.stdout on the base, and S3.stderr now"]);
  });

  // The same, through git: the base is the committed ref, the head the files.
  test.skipIf(process.platform === "win32")("reads the base from git and the head from the files", () => {
    const dir = tempDir();
    const put = (current) => {
      rmSync(join(dir, "tools/verify/mutants"), { recursive: true, force: true });
      mkdirSync(join(dir, "tools/verify/mutants"), { recursive: true });
      for (const mutant of current.mutants) writeFileSync(join(dir, `tools/verify/mutants/${mutant.id}.json`), JSON.stringify(mutant));
      writeFileSync(join(dir, "tools/verify/baseline.json"), JSON.stringify(current.baseline));
    };
    expect(atRef(dir, "HEAD")).toBeNull();
    put(base);
    commitAll(dir, "base");
    put(state(...base.mutants, escaping("f")));
    put({ ...atHead(dir), baseline: { known_escapes: 2, ids: ["e", "f"] } });
    expect(atRef(dir, "HEAD")).toEqual(base);
    expect(ratchet(atRef(dir, "HEAD"), atHead(dir))).toEqual(["baseline.json raises the known escapes from 1 to 2", "2 known escapes where the base has 1"]);
    const run = spawnSync(process.execPath, [VERIFY, "honesty", "--tree", dir, "--base", "HEAD"], { encoding: "utf8", env: { ...process.env, PATH } });
    expect(run.status).toBe(1);
    expect(run.stdout).toStartWith("ratchet: FAIL\n- baseline.json raises");
  });
});

describe("planting", () => {
  const repo = () => {
    const dir = tempDir();
    mkdirSync(join(dir, "plugins/pstack/hooks"), { recursive: true });
    writeFileSync(join(dir, "plugins/pstack/hooks/run.sh"), "echo hi\n", { mode: 0o755 });
    return commitAll(dir, "base");
  };
  const refused = (dir, edits) => {
    try {
      plant(dir, edits);
    } catch (err) {
      return err instanceof PlantDidNotApply ? err.message : `not a PlantDidNotApply: ${err.message}`;
    }
    return "applied";
  };

  test("each edit changes the tree", () => {
    const dir = repo();
    plant(dir, [
      { op: "replace", path: "plugins/pstack/hooks/run.sh", find: "hi", with: "bye" },
      { op: "write", path: "plugins/pstack/commands/new.md", content: "x" },
      { op: "chmod", path: "plugins/pstack/hooks/run.sh", mode: "644" },
    ]);
    expect(readFileSync(join(dir, "plugins/pstack/hooks/run.sh"), "utf8")).toBe("echo bye\n");
    expect(git(dir, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M plugins/pstack/hooks/run.sh", "?? plugins/pstack/commands/"]);
    plant(repo(), [{ op: "delete", path: "plugins/pstack/hooks" }]);
  });

  test.each([
    ["a replace that finds nothing", [{ op: "replace", path: "plugins/pstack/hooks/run.sh", find: "nope", with: "x" }], 'plugins/pstack/hooks/run.sh does not hold "nope"'],
    ["a delete of what is not there", [{ op: "delete", path: "plugins/pstack/hooks/gone.sh" }], "plugins/pstack/hooks/gone.sh is not there"],
    ["a chmod to the mode it has", [{ op: "chmod", path: "plugins/pstack/hooks/run.sh", mode: "755" }], "plugins/pstack/hooks/run.sh already has mode 755"],
    ["a write of what is there", [{ op: "write", path: "plugins/pstack/hooks/run.sh", content: "echo hi\n" }], "plugins/pstack/hooks/run.sh already holds that content"],
    ["a replace with itself", [{ op: "replace", path: "plugins/pstack/hooks/run.sh", find: "hi", with: "hi" }], "the edits left the tree as it was"],
  ])("%s did not apply", (_, edits, message) => {
    expect(refused(repo(), edits)).toBe(message);
  });
});

// The command, offline. The stand-in replays the untouched recordings, so a
// check judges the stage against them: that is what catches the mandate.
describe("bun tools/verify.mjs honesty, against the stand-in", () => {
  const honesty = (tree, mutants, ...more) => {
    const dir = tempDir();
    for (const [id, mutant] of Object.entries(mutants)) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, description: "test", ...mutant }));
    const { PSTACK_VERIFY_REQUIRE_CLI, GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...inherited } = process.env;
    const result = spawnSync(process.execPath, [VERIFY, "honesty", "--tree", tree, "--mutants", dir, ...more], { encoding: "utf8", env: { ...inherited, PATH, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI } });
    const rows = Object.fromEntries(result.stdout.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| mutant") && !line.startsWith("| ---")).map((line) => line.split(" | ")).map(([id, , status, note]) => [id.slice(2), [status, note.replace(/ \|$/, "")]]));
    return { status: result.status, head: result.stdout.split("\n")[0], rows, stdout: result.stdout, stderr: result.stderr };
  };
  const deleteMandate = [{ op: "delete", path: MANDATE }];

  test.skipIf(process.platform === "win32")("a mistake its check fails on is caught, and the tree under test is left alone", () => {
    const repo = productRepo();
    const run = honesty(repo, { gone: { edits: deleteMandate, catches: { check: "S3", assertion: "stdout" } } });
    expect(run.head).toBe("honesty: OK, 1 of 1 caught, 0 known escapes, 0 failing");
    expect(run.stdout).toContain("the verifier ran against a stand-in for the CLI");
    expect(run.rows.gone[0]).toBe("caught");
    expect(run.status).toBe(0);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, MANDATE))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, LONG);

  test.skipIf(process.platform === "win32")("a mistake no check fails on is an escape, and fails the run", () => {
    const run = honesty(productRepo(), { blind: { edits: [{ op: "write", path: "plugins/pstack/commands/stray.md", content: "x" }], catches: { check: "S2", assertion: "commands" } } });
    expect(run.rows.blind).toEqual(["ESCAPED", "S2 pass"]);
    expect(run.head).toBe("honesty: FAIL, 0 of 1 caught, 0 known escapes, 1 failing");
    expect(run.status).toBe(1);
  }, LONG);

  test.skipIf(process.platform === "win32")("a check that fails on another assertion than the one named is an escape", () => {
    const run = honesty(productRepo(), { off: { edits: deleteMandate, catches: { check: "S3", assertion: "skills-named-by-mistake" } } });
    expect(run.rows.off[0]).toBe("ESCAPED");
    expect(run.rows.off[1]).toStartWith("S3 failed on S3.");
    expect(run.status).toBe(1);
  }, LONG);

  test.skipIf(process.platform === "win32")("a known escape is reported and does not fail, until something catches it", () => {
    const reason = { reason: "nothing looks", future_check: "S99" };
    const escaping = honesty(productRepo(), { quiet: { edits: [{ op: "write", path: "plugins/pstack/commands/stray.md", content: "x" }], known_escape: reason } });
    expect(escaping.rows.quiet).toEqual(["known escape", "no check fails; S99 is to catch it"]);
    expect(escaping.head).toBe("honesty: OK, 0 of 1 caught, 1 known escape, 0 failing");
    expect(escaping.status).toBe(0);

    const closed = honesty(productRepo(), { loud: { edits: deleteMandate, known_escape: reason } });
    expect(closed.rows.loud[0]).toBe("PROMOTE");
    expect(closed.rows.loud[1]).toContain("blind spot closed, move the file to catches");
    expect(closed.status).toBe(1);
  }, LONG);

  test.skipIf(process.platform === "win32")("a plant that does not apply fails loudly and is no catch", () => {
    const run = honesty(productRepo(), { moved: { edits: [{ op: "replace", path: MANDATE, find: "text that is not there", with: "x" }], catches: { check: "S3" } } });
    expect(run.rows.moved[0]).toBe("NOT-APPLIED");
    expect(run.rows.moved[1]).toStartWith("PLANT DID NOT APPLY: ");
    expect(run.status).toBe(1);
  }, LONG);

  test.skipIf(process.platform === "win32")("a tree the verifier already fails on is no ground to judge from", () => {
    const repo = productRepo();
    rmSync(join(repo, MANDATE));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "no mandate");
    const run = honesty(repo, { gone: { edits: [{ op: "write", path: MANDATE, content: "" }], catches: { check: "S3" } } });
    expect(run.head).toStartWith("honesty: FAIL, the untouched tree fails S3");
    expect(run.status).toBe(1);
  }, LONG);

  test.skipIf(process.platform === "win32")("a tier with no check is said to hold none, not blamed on the CLI", () => {
    const run = honesty(productRepo(), { gone: { edits: deleteMandate, catches: { check: "S3" } } }, "--tier", "behavior");
    expect(run.head).toBe("honesty: FAIL, the verifier ran no check: no check in the behavior tier");
    expect(run.status).toBe(1);
  }, LONG);

  test.skipIf(process.platform === "win32")("--mutant runs one, and names the ones there are when it is not among them", () => {
    const mutants = { a: { edits: deleteMandate, catches: { check: "S3" } }, b: { edits: deleteMandate, catches: { check: "S3" } } };
    expect(Object.keys(honesty(productRepo(), mutants, "--mutant", "b").rows)).toEqual(["b"]);
    expect(honesty(productRepo(), mutants, "--mutant", "c").stderr).toContain("no mutant c; mutants: a, b");
  }, LONG);
});

// The two ways the judge itself can be made to pass a broken plugin, planted
// in a copy of the verifier and run for real. A driver that adds an argument
// could turn on a flag that hides what the check judges, and a checker that
// can start a process could rerun what it judges.
describe("a mistake in the judge", () => {
  const copy = () => {
    const dir = tempDir();
    for (const path of ["tools", "tests/verify"]) cpSync(join(ROOT, path), join(dir, path), { recursive: true });
    return dir;
  };

  test.skipIf(process.platform === "win32")("a driver that appends an argument fails the argv rule of every run", () => {
    const dir = copy();
    const drive = join(dir, "tools/verify/drive.mjs");
    const source = readFileSync(drive, "utf8");
    const planted = source.replace("...(run.args ?? [])];", '...(run.args ?? []), "--bare"];');
    expect(planted).not.toBe(source);
    writeFileSync(drive, planted);

    const { PSTACK_VERIFY_REQUIRE_CLI, GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...inherited } = process.env;
    const env = { ...inherited, PATH, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI };
    const run = (tool) => spawnSync(process.execPath, [join(tool, "tools/verify.mjs"), "--tier", "surface", "--tree", productRepo(), "--evidence", tempDir()], { encoding: "utf8", env });
    const untouched = run(ROOT);
    const doctored = run(dir);
    expect(untouched.stdout).toStartWith("STAND-IN");
    expect(doctored.status).toBe(1);
    expect(doctored.stdout).toStartWith("FAIL");
    expect(doctored.stdout).toMatch(/context\.argv: saw argv \[.*"--bare"\]/);
  }, LONG);

  test("a checker that imports child_process fails the role test", () => {
    const dir = copy();
    const check = join(dir, "tools/verify/check.mjs");
    writeFileSync(check, `import "node:child_process";\n${readFileSync(check, "utf8")}`);
    const test = (where) => spawnSync(process.execPath, ["test", "tests/verify/roles.test.mjs"], { cwd: where, encoding: "utf8" });
    const doctored = test(dir);
    expect(doctored.status).not.toBe(0);
    expect(doctored.stderr + doctored.stdout).toContain("only setup and the driver can start a process");
    expect(test(ROOT).status).toBe(0);
  }, LONG);
});
