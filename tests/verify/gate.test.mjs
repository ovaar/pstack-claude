// The push gate, in three layers: the table of command lines it recognises,
// the decision it makes from the facts, and both entry points run end to end
// against a small repository and the stand-in CLI. The stand-in is never
// PASS, so every end-to-end run that reaches the verifier must be blocked;
// the controls beside them (no watched path, no push, a bypass) must not be.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { BYPASS_LINE, decide, hitsOf, isWatched, judgeLine, prePushHits, segments } from "../../tools/verify/gate.mjs";
import { WATCHED } from "../../tools/verify/paths.mjs";
import { cleanup, git, productRepo, tempDir } from "./harness.mjs";

let tmp;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(cleanup);

const GATE = join(import.meta.dir, "../../tools/verify/gate.mjs");
const HOOK = join(import.meta.dir, "../../tools/verify/gate-hook.sh");
const FAKE_CLI = join(import.meta.dir, "fake-claude.mjs");
const BUN_DIR = dirname(process.execPath);
const WITHOUT_CLAUDE = process.env.PATH.split(delimiter).filter((dir) => !existsSync(join(dir, "claude")));
const PATH = [BUN_DIR, ...WITHOUT_CLAUDE].join(delimiter);
const LONG = 90_000;

// --- the table of command lines -----------------------------------------

const HERE = "/work/repo";
const kinds = (command) => hitsOf(command, HERE).map((hit) => `${hit.kind}@${hit.dir}`);
const PUSH = `push@${HERE}`;
const PR = `pr-create@${HERE}`;

const TABLE = [
  ["git push", [PUSH]],
  ["git push origin main", [PUSH]],
  ["git push --force-with-lease origin HEAD:refs/heads/x", [PUSH]],
  ["git push --dry-run", [PUSH]],
  ["git\tpush", [PUSH]],
  ["git -C /elsewhere push", ["push@/elsewhere"]],
  ["git -C sub push", [`push@${HERE}/sub`]],
  ["git -c core.hooksPath=/dev/null push", [PUSH]],
  ["git --no-pager push", [PUSH]],
  ["git --git-dir=/x/.git --work-tree=/x push", ["push@/x"]],
  ["gh pr create --fill", [PR]],
  ["gh pr create --draft --title 'a; b'", [PR]],
  ["gh -R owner/repo pr create", [PR]],
  ["git status && git push", [PUSH]],
  ["git add -A; git commit -m x; git push", [PUSH]],
  ["git commit -m x || git push", [PUSH]],
  ["git fetch\ngit push", [PUSH]],
  ["cd /elsewhere && git push", ["push@/elsewhere"]],
  ["cd sub && git push origin x", [`push@${HERE}/sub`]],
  ["cd /a && git status && cd ../b && git push", ["push@/b"]],
  ["git push && gh pr create --fill", [PUSH, PR]],
  ["FOO=1 git push", [PUSH]],
  ["FOO=1 BAR=2 git push origin x", [PUSH]],
  ["env FOO=1 git push", [PUSH]],
  ["env -u FOO git push", [PUSH]],
  ["command git push", [PUSH]],
  ["time git push", [PUSH]],
  ["/usr/bin/git push", [PUSH]],
  ["bash -c 'git push'", [PUSH]],
  ['sh -c "cd /x && git push"', ["push@/x"]],
  ["eval git push", [PUSH]],
  ["(git push)", [PUSH]],
  ["echo $(git push)", [PUSH]],
  ["if true; then git push; fi", [PUSH]],
  // Not a push: the words are data, the subcommand differs, or the program does.
  ['echo "git push"', []],
  ["echo git push", []],
  ["echo 'a; git push'", []],
  ['git commit -m "git push now"', []],
  ["git commit -m 'run gh pr create'", []],
  ['gh pr create-not-a-subcommand-x', []],
  ["git stash push", []],
  ["git status", []],
  ["git log --oneline | grep push", []],
  ["git config alias.p push", []],
  ["git pull", []],
  ["gh pr list", []],
  ["gh pr view --web", []],
  ["gh issue create", []],
  ["grep -r 'gh pr create' docs", []],
  ["ls -la", []],
  ["", []],
];

test.each(TABLE)("%j is read as %j", (command, expected) => {
  expect(kinds(command)).toEqual(expected);
});

test("quotes are removed from words and operators inside them split nothing", () => {
  expect(segments(`echo "a && b" 'c | d'; ls`)).toEqual([["echo", "a && b", "c | d"], ["ls"]]);
});

test("a path is watched when it is one or lies under one, and the list is the verifier's own", () => {
  expect(isWatched("plugins/pstack/skills/x/SKILL.md")).toBe(true);
  expect(isWatched("tools/verify/gate.mjs")).toBe(true);
  expect(isWatched("VERSION")).toBe(true);
  expect(isWatched("README.md")).toBe(false);
  expect(isWatched("plugins/pstackish/x")).toBe(false);
  expect(isWatched("docs/a.md", ["docs"])).toBe(true);
  expect(WATCHED).toContain(".claude/settings.json");
});

// --- what a verdict line is ---------------------------------------------

test.each([
  ["PASS surface 2/2 | behavior NOT BUILT | round 1", true],
  ["PASS surface 0/0 | behavior NOT BUILT | round 1", false],
  ["PASS surface 1/2 | behavior NOT BUILT | round 1", false],
  ["STAND-IN surface 2/2 | behavior NOT BUILT | round 1", false],
  ["PARTIAL surface 1/2 | behavior NOT BUILT | round 1", false],
  ["FAIL surface 1/2 | behavior NOT BUILT | round 2", false],
  ["SKIPPED surface: claude is not on PATH | behavior NOT BUILT | round 1", false],
  ["RECHECK PASS surface 2/2 | behavior NOT BUILT | round 1", false],
  ["", false],
  [undefined, false],
])("%j is a pass: %j", (line, ok) => {
  expect(judgeLine(line).ok).toBe(ok);
});

// --- the decision ---------------------------------------------------------

// Facts by name, and what the gate asked for, so a case can say that the
// verifier was not started.
function facts({ sha = "a".repeat(40), inScope = true, touches = true, line = "PASS surface 2/2 | behavior NOT BUILT | round 1" } = {}) {
  const asked = [];
  return {
    asked,
    io: {
      subject: () => (asked.push("subject"), sha === null ? null : { sha, inScope }),
      touches: () => (asked.push("touches"), touches),
      verify: () => (asked.push("verify"), line),
    },
  };
}
const PUSHING = [{ kind: "push", dir: HERE }];
const run = async (options, hits = PUSHING, env = {}) => {
  const { io, asked } = facts(options);
  return { ...(await decide({ hits, env }, io)), asked };
};

test("a pass on a watched push allows it", async () => {
  expect(await run()).toEqual({ allow: true, asked: ["subject", "touches", "verify"] });
});

test("no push, no questions", async () => {
  expect(await run({}, [])).toEqual({ allow: true, asked: [] });
});

test("a push that touches no watched path, or no tree of this plugin, never starts the verifier", async () => {
  expect(await run({ touches: false })).toEqual({ allow: true, asked: ["subject", "touches"] });
  expect(await run({ inScope: false })).toEqual({ allow: true, asked: ["subject"] });
  expect(await run({ sha: null })).toEqual({ allow: true, asked: ["subject"] });
});

test("the bypass allows, says so, and asks for nothing", async () => {
  expect(await run({ line: "FAIL" }, PUSHING, { PSTACK_VERIFY_GATE: "off" })).toEqual({ allow: true, message: BYPASS_LINE, asked: [] });
  expect(BYPASS_LINE).toBe("verify gate bypassed by PSTACK_VERIFY_GATE=off");
  expect((await run({ line: "FAIL surface 1/2 | x | round 1" }, PUSHING, { PSTACK_VERIFY_GATE: "on" })).allow).toBe(false);
});

test.each([
  ["FAIL surface 1/2 | behavior NOT BUILT | round 1", /did not pass.*round 1 of 3.*Fix what it names/s],
  ["STAND-IN surface 2/2 | behavior NOT BUILT | round 1", /stand-in CLI.*unset PSTACK_VERIFY_CLAUDE/s],
  ["SKIPPED surface: claude is not on PATH | behavior NOT BUILT | round 1", /did not run.*install Claude Code/s],
  ["PARTIAL surface 1/2 | behavior NOT BUILT | round 1", /did not pass/],
  ["", /did not pass/],
])("anything but a PASS blocks and names the fix: %j", async (line, message) => {
  const verdict = await run({ line });
  expect(verdict.allow).toBe(false);
  expect(verdict.message).toMatch(message);
  expect(verdict.message).toContain("Do not set it");
});

test("the third failed round, or a BLOCKED verdict, tells the agent to stop and report", async () => {
  for (const line of ["FAIL surface 1/2 | behavior NOT BUILT | round 3", "FAIL surface 1/2 | behavior NOT BUILT | round 4", "BLOCKED surface 1/2 | behavior NOT BUILT | round 3"]) {
    const verdict = await run({ line });
    expect(verdict.allow).toBe(false);
    expect(verdict.message).toMatch(/STOP\. Do not edit further and do not push\. Report to the human/);
  }
  expect((await run({ line: "FAIL surface 1/2 | behavior NOT BUILT | round 2" })).message).not.toContain("STOP");
});

test("the first hit that fails decides, and a later one is not verified", async () => {
  const verdict = await run({ line: "FAIL surface 1/2 | x | round 1" }, [...PUSHING, { kind: "pr-create", dir: HERE }]);
  expect(verdict.allow).toBe(false);
  expect(verdict.asked.filter((ask) => ask === "verify")).toHaveLength(1);
});

test("pre-push hits come from the refs pre-commit exports, or from git's stdin, and a deletion is no push", () => {
  const sha = "b".repeat(40);
  const from = "c".repeat(40);
  expect(prePushHits({ PRE_COMMIT_TO_REF: sha, PRE_COMMIT_FROM_REF: from, PRE_COMMIT_REMOTE_NAME: "origin" }, "", "/r")).toEqual([{ kind: "push", dir: "/r", remote: "origin", sha, from }]);
  expect(prePushHits({}, `refs/heads/x ${sha} refs/heads/x ${from}\n`, "/r")).toEqual([{ kind: "push", dir: "/r", remote: undefined, sha, from }]);
  expect(prePushHits({}, `(delete) ${"0".repeat(40)} refs/heads/x ${from}\n`, "/r")).toEqual([]);
  expect(prePushHits({}, "", "/r")).toEqual([]);
});

// --- both entry points, end to end ----------------------------------------

// A repository with a remote that already holds its first commit, so that
// what the next commit changes is what a push would carry.
function pushable() {
  const repo = productRepo();
  const remote = join(tempDir(), "remote.git");
  git(repo, "clone", "--bare", "--quiet", repo, remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  return { repo, remote };
}

function commit(repo, file, text = "changed\n") {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", `change ${file}`);
}

const watchedChange = (repo) => commit(repo, "tools/verify/planted.txt");
const unwatchedChange = (repo) => commit(repo, "README.md", "another word\n");

function hook(command, { cwd, env = {}, path = PATH } = {}) {
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
  const result = spawnSync("/bin/sh", [HOOK], { input: payload, encoding: "utf8", env: { PATH: path, HOME: tmp, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, ...env } });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test.skipIf(process.platform === "win32")("the Claude Code hook lets ordinary commands through, with or without bun", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const NO_BUN = "/usr/bin:/bin";
  for (const command of ["ls", "git status", "git log --oneline", "bun test"]) expect(hook(command, { cwd: repo, path: NO_BUN })).toMatchObject({ status: 0, stderr: "" });
  // A command that only mentions a push: sh lets it reach the parser with bun, which passes it,
  // and without bun says why it could not look and passes it.
  for (const command of ['echo "git push"', "git commit -m 'git push'", "grep -r 'gh pr create' docs"]) {
    expect([command, hook(command, { cwd: repo }).status]).toEqual([command, 0]);
    const without = hook(command, { cwd: repo, path: NO_BUN });
    expect([command, without.status, without.stderr]).toEqual([command, 0, expect.stringContaining("bun is not on PATH")]);
  }
});

test.skipIf(process.platform === "win32")("the Claude Code hook blocks a push of a watched change, and the stand-in is no pass", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const blocked = hook("git push", { cwd: repo });
  expect(blocked.status).toBe(2);
  expect(blocked.stderr).toContain("verify gate: the verifier ran against a stand-in CLI");
  expect(blocked.stderr).toContain("unset PSTACK_VERIFY_CLAUDE");
  // The scratch checkout of the commit is gone, and so is its worktree entry.
  expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
}, LONG);

test.skipIf(process.platform === "win32")("the Claude Code hook follows `git -C`, `cd` and a chained command to the repository pushed from", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const elsewhere = tempDir();
  for (const command of [`git -C ${repo} push`, `cd ${repo} && git push origin HEAD`, `git status; cd ${repo}; git push`, `FOO=1 git -C ${repo} push`]) {
    const verdict = hook(command, { cwd: elsewhere });
    expect([command, verdict.status]).toEqual([command, 2]);
  }
}, LONG);

test.skipIf(process.platform === "win32")("the Claude Code hook passes a push that carries no watched change", () => {
  const { repo } = pushable();
  unwatchedChange(repo);
  expect(hook("git push", { cwd: repo })).toMatchObject({ status: 0, stderr: "" });
});

test.skipIf(process.platform === "win32")("the Claude Code hook gates `gh pr create` on the branch against main, even when it is already pushed", () => {
  const { repo } = pushable();
  watchedChange(repo);
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/topic");
  expect(hook("gh pr create --fill", { cwd: repo }).status).toBe(2);
  expect(hook("git push", { cwd: repo }).status).toBe(0);
}, LONG);

test.skipIf(process.platform === "win32")("the bypass allows, and says so, only when the session was started with it", () => {
  const { repo } = pushable();
  watchedChange(repo);
  expect(hook("git push", { cwd: repo, env: { PSTACK_VERIFY_GATE: "off" } })).toMatchObject({ status: 0, stderr: `${BYPASS_LINE}\n` });
  // Typed in the command, it is a word of the command and decides nothing.
  expect(hook("PSTACK_VERIFY_GATE=off git push", { cwd: repo }).status).toBe(2);
  // Not a push: nothing to say.
  expect(hook("ls", { cwd: repo, env: { PSTACK_VERIFY_GATE: "off" } })).toMatchObject({ status: 0, stderr: "" });
}, LONG);

test.skipIf(process.platform === "win32")("with no bun, a push is blocked with the fix and anything else passes", () => {
  const { repo } = pushable();
  const noBun = { cwd: repo, path: "/usr/bin:/bin" };
  const blocked = hook("git push origin main", noBun);
  expect(blocked.status).toBe(2);
  expect(blocked.stderr).toContain("bun is not on PATH");
  expect(blocked.stderr).toContain("install bun");
  expect(hook("gh pr create --fill", noBun).status).toBe(2);
  expect(hook("git status", noBun)).toMatchObject({ status: 0, stderr: "" });
});

test.skipIf(process.platform === "win32")("with no claude on PATH, a push is blocked and the message names the fix", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const blocked = hook("git push", { cwd: repo, env: { PSTACK_VERIFY_CLAUDE: "" } });
  expect(blocked.status).toBe(2);
  expect(blocked.stderr).toContain("install Claude Code");
  // The same absence does not touch a command that is not a push.
  expect(hook("git status", { cwd: repo, env: { PSTACK_VERIFY_CLAUDE: "" } })).toMatchObject({ status: 0, stderr: "" });
}, LONG);

test.skipIf(process.platform === "win32")("a receipt is not read: a PASS receipt for this very tree does not open the gate", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir").trim();
  mkdirSync(join(gitDir, "pstack-verify"), { recursive: true });
  writeFileSync(join(gitDir, "pstack-verify", "receipt.json"), JSON.stringify({ verdict: "PASS", checks: [{ id: "S2", verdict: "pass" }] }));
  expect(hook("git push", { cwd: repo }).status).toBe(2);
}, LONG);

test.skipIf(process.platform === "win32")("three failed rounds end in a stop message that tells the agent to report", () => {
  const { repo } = pushable();
  // A VERSION the recorded traces do not agree with fails a check.
  commit(repo, "VERSION", "9.9.9\n");
  const messages = [1, 2, 3].map(() => hook("git push", { cwd: repo }));
  expect(messages.map((m) => m.status)).toEqual([2, 2, 2]);
  expect(messages[0].stderr).toMatch(/round 1 of 3/);
  expect(messages[1].stderr).toMatch(/round 2 of 3/);
  expect(messages[2].stderr).toMatch(/STOP\. Do not edit further and do not push\. Report to the human/);
}, 3 * LONG);

const prePush = (repo, sha, from, { env = {}, remote = "origin" } = {}) => {
  const result = spawnSync(process.execPath, [GATE, "pre-push"], {
    cwd: repo,
    input: "",
    encoding: "utf8",
    env: { PATH, HOME: tmp, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, PRE_COMMIT_TO_REF: sha, PRE_COMMIT_FROM_REF: from, PRE_COMMIT_REMOTE_NAME: remote, ...env },
  });
  return { status: result.status, stderr: result.stderr };
};

test.skipIf(process.platform === "win32")("the pre-push entry judges the commit pushed, not the working tree", () => {
  const { repo } = pushable();
  const base = git(repo, "rev-parse", "HEAD").trim();
  watchedChange(repo);
  const head = git(repo, "rev-parse", "HEAD").trim();
  // The pushed commit changed a watched path; the working tree is then put back where the remote is.
  git(repo, "checkout", "--quiet", "--detach", base);
  expect(prePush(repo, head, base)).toMatchObject({ status: 1, stderr: expect.stringContaining("stand-in CLI") });
  // A commit with no watched change, though a later one has.
  expect(prePush(repo, base, base)).toMatchObject({ status: 0, stderr: "" });
  // A new branch is compared with what the remote has: a zero sha for the remote.
  expect(prePush(repo, head, "0".repeat(40)).status).toBe(1);
  expect(prePush(repo, head, base, { env: { PSTACK_VERIFY_GATE: "off" } })).toMatchObject({ status: 0, stderr: `${BYPASS_LINE}\n` });
}, LONG);

test.skipIf(process.platform === "win32")("a real git pre-push hook stops `git push`, leaves the remote as it was, and `--no-verify` is the only way past it", () => {
  const { repo, remote } = pushable();
  watchedChange(repo);
  const hookFile = join(git(repo, "rev-parse", "--absolute-git-dir").trim(), "hooks", "pre-push");
  mkdirSync(dirname(hookFile), { recursive: true });
  writeFileSync(hookFile, `#!/bin/sh\nexec "${process.execPath}" "${GATE}" pre-push\n`, { mode: 0o755 });
  const env = { PATH, HOME: tmp, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, GIT_CONFIG_GLOBAL: "/dev/null" };
  const before = git(remote, "rev-parse", "main").trim();
  const push = spawnSync("git", ["-C", repo, "push", "origin", "HEAD:refs/heads/main"], { encoding: "utf8", env });
  expect(push.status).not.toBe(0);
  expect(push.stderr).toContain("verify gate: the verifier ran against a stand-in CLI");
  expect(git(remote, "rev-parse", "main").trim()).toBe(before);
  // A push that carries nothing watched goes through the same hook.
  git(repo, "reset", "--quiet", "--hard", "HEAD~1");
  unwatchedChange(repo);
  const clean = spawnSync("git", ["-C", repo, "push", "origin", "HEAD:refs/heads/main"], { encoding: "utf8", env });
  expect(clean.status).toBe(0);
}, LONG);
