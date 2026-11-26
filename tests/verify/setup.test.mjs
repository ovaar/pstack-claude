// Setup decides what is under test and what reaches a session: the snapshot
// of the tree as it would be committed, the stage, the allow-listed
// environment, and which CLI is fit to drive.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { buildStage, childEnv, doctor, findCli, olderThan, plan, snapshot } from "../../tools/verify/setup.mjs";
import { stageHash } from "../../tools/verify/stage.mjs";
import { cleanup, git, productRepo, tempDir } from "./harness.mjs";

afterEach(cleanup);

const MANDATE = "plugins/pstack/hooks/session-start-context.md";
// Each of these starts git or a stand-in CLI several times; under a loaded
// machine the default five seconds is not enough.
const LONG = 30_000;

describe("snapshot and stage", () => {
  test("the stage holds uncommitted and untracked product files, and nothing else from the tree", () => {
    const repo = productRepo();
    writeFileSync(join(repo, "VERSION"), "9.9.9\n");
    writeFileSync(join(repo, "plugins/pstack/hooks/new-hook.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const { stage } = buildStage(snapshot(repo), join(tempDir(), "stage"));
    expect(readFileSync(join(stage, "VERSION"), "utf8")).toBe("9.9.9\n");
    expect(statSync(join(stage, "plugins/pstack/hooks/new-hook.sh")).mode & 0o111).toBe(0o111);
    expect(existsSync(join(stage, MANDATE))).toBe(true);
    expect(existsSync(join(stage, "README.md"))).toBe(false);
  }, LONG);

  test.skipIf(process.platform === "win32")("a lost executable bit and a deleted file both reach the stage", () => {
    const repo = productRepo();
    writeFileSync(join(repo, "plugins/pstack/hooks/session-start.sh"), "#!/bin/sh\n", { mode: 0o755 });
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "hook");
    chmodSync(join(repo, "plugins/pstack/hooks/session-start.sh"), 0o644);
    rmSync(join(repo, MANDATE));
    const { stage } = buildStage(snapshot(repo), join(tempDir(), "stage"));
    expect(statSync(join(stage, "plugins/pstack/hooks/session-start.sh")).mode & 0o111).toBe(0);
    expect(existsSync(join(stage, MANDATE))).toBe(false);
  }, LONG);

  test("taking a snapshot leaves the index and the working tree as they were", () => {
    const repo = productRepo();
    writeFileSync(join(repo, "VERSION"), "9.9.9\n");
    writeFileSync(join(repo, "untracked.txt"), "left alone\n");
    const before = git(repo, "status", "--porcelain");
    snapshot(repo);
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(before).toBe(" M VERSION\n?? untracked.txt\n");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  }, LONG);

  test("the subject changes with a watched path and not with any other", () => {
    const repo = productRepo();
    const first = snapshot(repo).subjectId;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(repo, "README.md"), "edited, and not watched\n");
    expect(snapshot(repo).subjectId).toBe(first);
    mkdirSync(join(repo, "tools/verify/checks"), { recursive: true });
    writeFileSync(join(repo, "tools/verify/checks/S9-new.mjs"), "export const tier = 'surface';\n");
    const judged = snapshot(repo).subjectId;
    expect(judged).not.toBe(first);
    writeFileSync(join(repo, MANDATE), "edited\n");
    expect(snapshot(repo).subjectId).not.toBe(judged);
  }, LONG);

  test("the recorded stage hash is the one the checker recomputes, until the stage is edited", () => {
    const { stage, stageHash: recorded } = buildStage(snapshot(productRepo()), join(tempDir(), "stage"));
    expect(stageHash(stage)).toBe(recorded);
    writeFileSync(join(stage, "VERSION"), "9.9.9\n");
    expect(stageHash(stage)).not.toBe(recorded);
    expect(stageHash(join(stage, "gone"))).toBeNull();
  }, LONG);

  test("a tree with no product path is refused", () => {
    const repo = tempDir();
    writeFileSync(join(repo, "README.md"), "no product here\n");
    git(repo, "init", "--quiet");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "empty");
    expect(() => buildStage(snapshot(repo), join(tempDir(), "stage"))).toThrow("holds none of plugins/pstack, .claude-plugin, VERSION");
  }, LONG);
});

describe("a session's environment", () => {
  const box = { home: "/sandbox/home", config: "/sandbox/config", cwd: "/sandbox/cwd" };
  const parent = {
    PATH: "/usr/bin",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    HOME: "/the/real/home",
    CLAUDE_CONFIG_DIR: "/the/real/home/.claude",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy",
    CLAUDE_PROJECT_DIR: "/the/real/project",
    ANTHROPIC_API_KEY: "dummy",
    PSTACK_SESSION_HOOK: "off",
    PLUGIN_ROOT: "/x",
    MINIMAX_PLUGIN_ROOT: "/x",
  };

  test("only the allow-list is inherited, and home and config are the sandbox's", () => {
    expect(childEnv(box, parent)).toEqual({ PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "en_US.UTF-8", HOME: "/sandbox/home", CLAUDE_CONFIG_DIR: "/sandbox/config" });
  });

  test("a variable the parent lacks is left out, not passed as undefined", () => {
    expect(Object.keys(childEnv(box, { PATH: "/usr/bin" })).sort()).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  });

  test("each run gets a sandbox of its own", () => {
    const base = tempDir();
    const flows = [
      { id: "S2", runs: [{ name: "context", args: ["/context"], stdin: "" }] },
      { id: "S3", runs: [{ name: "startup", args: [], stdin: "x" }] },
    ];
    const runs = plan(flows, base, parent);
    expect(runs.map((run) => [run.id, run.name, run.cwd])).toEqual([
      ["S2", "context", join(base, "S2/context/cwd")],
      ["S3", "startup", join(base, "S3/startup/cwd")],
    ]);
    expect(runs[1].env).toEqual({ PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "en_US.UTF-8", HOME: join(base, "S3/startup/home"), CLAUDE_CONFIG_DIR: join(base, "S3/startup/config") });
    expect(existsSync(runs[0].config)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("doctor", () => {
  const pin = { verified: "2.1.332", minimum: "2.1.332" };
  const box = { home: "/sandbox/home", config: "/sandbox/config" };

  function cli(output) {
    const dir = tempDir();
    writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
    return dir;
  }

  test("versions compare by number, not as text", () => {
    expect(olderThan("2.1.245", "2.1.332")).toBe(true);
    expect(olderThan("2.1.332", "2.1.332")).toBe(false);
    expect(olderThan("2.1.1000", "2.1.332")).toBe(false);
    expect(olderThan("2.2.0", "2.1.332")).toBe(false);
    expect(olderThan("1.9.999", "2.1.332")).toBe(true);
  });

  test("the CLI is the one PSTACK_VERIFY_CLAUDE names, else the first claude on PATH", () => {
    const [first, second] = [cli("2.1.332 (Claude Code)"), cli("2.1.332 (Claude Code)")];
    expect(findCli({ PATH: [tempDir(), first, second].join(delimiter) })).toBe(join(first, "claude"));
    expect(findCli({ PATH: first, PSTACK_VERIFY_CLAUDE: join(second, "claude") })).toBe(join(second, "claude"));
    expect(findCli({ PATH: tempDir() })).toBeNull();
  });

  test("the pinned version can be driven", () => {
    const path = join(cli("2.1.332 (Claude Code)"), "claude");
    expect(doctor(box, { PATH: "/usr/bin:/bin", PSTACK_VERIFY_CLAUDE: path }, pin)).toEqual({ path, version: "2.1.332", missing: false, required: false, problem: null });
  }, LONG);

  test("a newer version can be driven; the checker reports the difference as an observation", () => {
    const env = { PATH: "/usr/bin:/bin", PSTACK_VERIFY_CLAUDE: join(cli("2.1.400 (Claude Code)"), "claude") };
    expect(doctor(box, env, pin)).toMatchObject({ version: "2.1.400", problem: null });
  }, LONG);

  test("a version below the minimum is a problem", () => {
    const env = { PATH: "/usr/bin:/bin", PSTACK_VERIFY_CLAUDE: join(cli("2.1.245 (Claude Code)"), "claude") };
    expect(doctor(box, env, pin)).toMatchObject({ version: "2.1.245", missing: false, problem: "claude 2.1.245 is older than the minimum 2.1.332" });
  }, LONG);

  test("no CLI is reported as missing, and as required when the environment says so", () => {
    const empty = tempDir();
    expect(doctor(box, { PATH: empty }, pin)).toEqual({ path: null, version: null, missing: true, required: false, problem: "claude is not on PATH" });
    expect(doctor(box, { PATH: empty, PSTACK_VERIFY_REQUIRE_CLI: "1" }, pin)).toMatchObject({ missing: true, required: true });
    expect(doctor(box, { PATH: empty, PSTACK_VERIFY_CLAUDE: join(empty, "claude") }, pin)).toMatchObject({ missing: true, problem: "PSTACK_VERIFY_CLAUDE does not name an executable" });
  }, LONG);
});
