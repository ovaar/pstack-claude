// The push gate, in three layers: the table of command lines it recognises,
// the decision it makes from the facts, and both entry points run end to end
// against a small repository and the stand-in CLI. The stand-in is never
// PASS, so every end-to-end run that reaches the verifier must be blocked;
// the controls beside them (no watched path, no push, a bypass) must not be.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { BYPASS_LINE, decide, hitsOf, isWatched, installHook, judgeChanges, judgeLine, prePushHits, pushPlan, segments, verifyCommit, VERIFIER_TIMEOUT_MS } from "../../tools/verify/gate.mjs";
import { check } from "../../tools/verify/check.mjs";
import { WATCHED } from "../../tools/verify/paths.mjs";
import { cleanup, commitAll, ENGINE, evidence, git, productRepo, tempDir } from "./harness.mjs";

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

// Claude Code never shows the agent stderr from a hook that exits 0. What a
// passing hook says to the agent is JSON on stdout: `additionalContext` goes to
// the model and `systemMessage` to the person.
function agentSees({ stdout }) {
  const output = JSON.parse(stdout);
  expect(output.systemMessage).toBe(output.hookSpecificOutput.additionalContext);
  expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  return output.hookSpecificOutput.additionalContext;
}

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
  ["sudo git push", [PUSH]],
  ["sudo -u bob -E git push", [PUSH]],
  ["timeout 600 git push", [PUSH]],
  ["timeout -k 5 --signal=TERM 600 git push", [PUSH]],
  ["nice git push", [PUSH]],
  ["nice -n 10 git push", [PUSH]],
  ["xargs git push", [PUSH]],
  ["xargs -n1 -I{} git push {}", [PUSH]],
  ["gh pr new --fill", [PR]],
  ["git -c alias.p=push p", [PUSH]],
  ["git -c user.name=x -c alias.up='push --force' up origin", [PUSH]],
  ["git -c alias.p='!git push' p", [PUSH]],
  ["bash -c -- 'git push'", [PUSH]],
  ["bash -lc 'git push'", [PUSH]],
  ["gi''t push", [PUSH]],
  ["g\\it push", [PUSH]],
  // Not a push: the words are data, the subcommand differs, or the program does.
  ["gh pr create --dry-run", []],
  ["gh pr create --help", []],
  ["gh pr new -h", []],
  ["git -c alias.p=status p", []],
  ["sudo ls", []],
  ["timeout 600 ls", []],
  ["xargs echo git push", []],
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
  ["PARTIAL surface 2/2 | behavior NOT RUN | round 1", true],
  ["PARTIAL surface 2/2 | behavior NOT RUN | round 3", true],
  ["PARTIAL surface 1/2 | behavior NOT RUN | round 1", false],
  ["PARTIAL surface 0/0 | behavior NOT RUN | round 1", false],
  ["PARTIAL surface 2/2 | behavior 1/3 | round 1", false],
  ["PARTIAL surface 2/2 | behavior NOT BUILT | round 1", true],
  // The line the surface tier prints on this tree, read from a real run.
  ["PARTIAL surface 7/7 | behavior NOT RUN | round 1", true],
  ["PARTIAL surface 7/7 | behavior NOT RUN: no credential | round 2", true],
  ["PASS surface 7/7 | behavior 5/5 (15 model calls, $0.0420) | round 1", true],
  ["PARTIAL surface 7/7 | behavior: claude is too old | round 1", false],
  ["PARTIAL surface 7/7 | behavior 3/5 (9 model calls, $0.0100) | round 1", false],
  ["PASS surface 7/7 | extra | round 1", false],
  ["PARTIAL surface 7/7 | behavior NOT RUN", false],
  ["PARTIAL surface NOT RUN | behavior 2/2 | round 1", false],
  ["STAND-IN surface 2/2 | behavior NOT RUN | round 1", false],
  ["FAIL surface 2/2 | behavior NOT RUN | round 1", false],
  ["RECHECK PARTIAL surface 2/2 | behavior NOT RUN | round 1", false],
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
    expect([command, without.status, without.stderr, agentSees(without)]).toEqual([command, 0, "", expect.stringContaining("bun is not on PATH")]);
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
  const bypassed = hook("git push", { cwd: repo, env: { PSTACK_VERIFY_GATE: "off" } });
  expect([bypassed.status, bypassed.stderr, agentSees(bypassed)]).toEqual([0, "", BYPASS_LINE]);
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

test.skipIf(process.platform === "win32")("three failed rounds, each on a commit changed since the last, end in a stop message that tells the agent to report", () => {
  const { repo } = pushable();
  // A VERSION the recorded traces do not agree with fails a check.
  const messages = [1, 2, 3].map((round) => {
    commit(repo, "VERSION", `9.9.${round}\n`);
    return hook("git push", { cwd: repo });
  });
  expect(messages.map((m) => m.status)).toEqual([2, 2, 2]);
  expect(messages[0].stderr).toMatch(/round 1 of 3/);
  expect(messages[1].stderr).toMatch(/round 2 of 3/);
  expect(messages[2].stderr).toMatch(/STOP\. Do not edit further and do not push\. Report to the human/);
}, 3 * LONG);

test.skipIf(process.platform === "win32")("pushing the same failing commit again is not another round, and a changed one is", () => {
  const { repo } = pushable();
  commit(repo, "VERSION", "9.9.1\n");
  const rounds = [1, 2, 3, 4].map(() => hook("git push", { cwd: repo }));
  expect(rounds.map((m) => m.status)).toEqual([2, 2, 2, 2]);
  for (const blocked of rounds) expect(blocked.stderr).toMatch(/round 1 of 3/);
  commit(repo, "VERSION", "9.9.2\n");
  expect(hook("git push", { cwd: repo }).stderr).toMatch(/round 2 of 3/);
  expect(hook("git push", { cwd: repo }).stderr).toMatch(/round 2 of 3/);
}, 8 * LONG);

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
  // The pushed commit fails a check (the recordings name another version), the stand-in alone would not.
  commit(repo, "VERSION", "9.9.9\n");
  const head = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "--quiet", "--detach", base);
  expect(prePush(repo, head, base)).toMatchObject({ status: 1, stderr: expect.stringContaining("the verifier did not pass") });
  // A new branch is compared with what the remote has: a zero sha for the remote.
  expect(prePush(repo, head, "0".repeat(40)).status).toBe(1);
  expect(prePush(repo, head, base, { env: { PSTACK_VERIFY_GATE: "off" } })).toMatchObject({ status: 0, stderr: `${BYPASS_LINE}\n` });
  // A push that carries nothing watched is not verified at all.
  expect(prePush(repo, base, base)).toMatchObject({ status: 0, stderr: expect.stringContaining("install-hook") });
}, LONG);

test.skipIf(process.platform === "win32")("the Claude Code hook judges HEAD, not what is uncommitted", () => {
  const { repo } = pushable();
  watchedChange(repo);
  writeFileSync(join(repo, "VERSION"), "9.9.9\n");
  const blocked = hook("git push", { cwd: repo });
  expect(blocked.status).toBe(2);
  expect(blocked.stderr).toContain("stand-in CLI");
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

test.skipIf(process.platform === "win32")("the project settings register the hook on Bash, and the command they name runs and blocks", () => {
  const root = join(import.meta.dir, "../..");
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  expect(Object.keys(settings)).toEqual(["hooks"]);
  const entries = settings.hooks.PreToolUse;
  expect(entries).toHaveLength(1);
  expect(entries[0].matcher).toBe("Bash");
  const [{ type, command, timeout }] = entries[0].hooks;
  expect([type, timeout >= 300]).toEqual(["command", true]);
  // Claude Code runs the command through a shell with CLAUDE_PROJECT_DIR set, and the payload on stdin.
  const { repo } = pushable();
  watchedChange(repo);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" }, cwd: repo });
  const env = { PATH, HOME: tmp, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, CLAUDE_PROJECT_DIR: root };
  expect(spawnSync("/bin/sh", ["-c", command], { input: payload, encoding: "utf8", env }).status).toBe(2);
  expect(spawnSync("/bin/sh", ["-c", command], { input: payload.replace("git push", "git status"), encoding: "utf8", env }).status).toBe(0);
}, LONG);

// --- the gate fails closed ------------------------------------------------

// Claude Code lets the tool run when a PreToolUse hook exits with anything but
// 0 or 2, or when it times out. A gate that crashes must therefore say 2 itself.
test.skipIf(process.platform === "win32")("a gate that crashes blocks the push with exit 2, not a stack trace and exit 1", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const crashed = hook("git push", { cwd: repo, env: { TMPDIR: join(tmp, "missing", "dir") } });
  expect(crashed.status).toBe(2);
  expect(crashed.stderr).toMatch(/verify gate: .*crashed.*push is refused/s);
  expect(crashed.stderr).toContain("Do not set it");
}, LONG);

test.skipIf(process.platform === "win32")("a bun that dies, or a payload that is not JSON, blocks a command that looks like a push", () => {
  const { repo } = pushable();
  const fake = tempDir();
  writeFileSync(join(fake, "bun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const died = hook("git push", { cwd: repo, path: `${fake}:/usr/bin:/bin` });
  expect(died.status).toBe(2);
  expect(died.stderr).toContain("exit 1");
  const raw = spawnSync("/bin/sh", [HOOK], { input: "git push, but not a JSON payload", encoding: "utf8", env: { PATH, HOME: tmp, TMPDIR: tmp } });
  expect(raw.status).toBe(2);
  expect(raw.stderr).toContain("could not read");
});

test("the settings make a hook that fails or times out block, and the gate ends before the hook is cut off", () => {
  const root = join(import.meta.dir, "../..");
  const [{ onFailure, timeout }] = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).hooks.PreToolUse[0].hooks;
  expect(onFailure).toBe("block");
  expect(timeout * 1000).toBeGreaterThan(VERIFIER_TIMEOUT_MS);
});

// Each of these is a push the parser sees. The shell filter in front of it
// must not be stricter than the parser, or it never gets the chance.
test.skipIf(process.platform === "win32")("the Claude Code hook blocks the push spellings the parser reads, quoted, wrapped or aliased", () => {
  const { repo } = pushable();
  watchedChange(repo);
  const spellings = ["gi''t push", "g\\it push", 'g"i"t push', "gh pr new --fill", "gh pr cr''eate", "sudo git push", "timeout 600 git push", "nice git push", "xargs git push", "git -c alias.p=push p", "bash -c -- 'git push'"];
  for (const command of spellings) expect([command, hook(command, { cwd: repo }).status]).toEqual([command, 2]);
}, 12 * LONG);

// --- which commits a push sends -------------------------------------------

test.each([
  [[], { refs: ["HEAD"] }],
  [["origin"], { refs: ["HEAD"] }],
  [["origin", "bad"], { refs: ["bad"] }],
  [["origin", "bad:refs/heads/main"], { refs: ["bad"] }],
  [["-u", "--force-with-lease=main:abc", "origin", "+bad:main", "HEAD~1:other"], { refs: ["bad", "HEAD~1"] }],
  [["origin", "good:aa-good", "rev:zz-bad"], { refs: ["good", "rev"] }],
  [["origin", "tag", "v1"], { refs: ["refs/tags/v1"] }],
  [["-o", "ci.skip", "origin", "bad"], { refs: ["bad"] }],
  [["--repo", "x", "bad"], { refs: ["bad"] }],
  [["--", "origin", "bad"], { refs: ["bad"] }],
  [["origin", ":old"], { refs: [] }],
  [["--delete", "origin", "old"], { refs: [] }],
  [["-d", "origin", "old"], { refs: [] }],
  [["--dry-run", "origin", "bad"], { refs: [] }],
  [["-n", "origin", "bad"], { refs: [] }],
  [["-fn", "origin", "bad"], { refs: [] }],
  [["--help"], { refs: [] }],
  [["--all", "origin"], { refuse: expect.stringContaining("--all") }],
  [["--mirror", "origin"], { refuse: expect.stringContaining("--mirror") }],
  [["--tags", "origin"], { refuse: expect.stringContaining("--tags") }],
  [["origin", "refs/heads/*:refs/heads/*"], { refuse: expect.stringContaining("pattern") }],
])("`git push %j` sends %j", (args, plan) => {
  expect(pushPlan(args)).toEqual(plan);
});

// HEAD is main with nothing new to send. `bad` carries a watched change and
// `good` one that is not watched. The stand-in is never a pass, so a push that
// reaches the verifier is blocked and one that does not is allowed.
function branched() {
  const { repo } = pushable();
  watchedChange(repo);
  git(repo, "branch", "bad");
  git(repo, "reset", "--quiet", "--hard", "HEAD~1");
  unwatchedChange(repo);
  git(repo, "branch", "good");
  git(repo, "reset", "--quiet", "--hard", "HEAD~1");
  return repo;
}

test.skipIf(process.platform === "win32")("the Claude Code hook judges the ref a push names, not the HEAD it is run from", () => {
  const repo = branched();
  for (const command of ["git push origin bad", "git push origin bad:refs/heads/main", "git push origin refs/heads/bad", "git push origin good:aa-good bad:zz-bad", "git push origin +bad:bad", "git push --force origin bad"]) {
    expect([command, hook(command, { cwd: repo }).status]).toEqual([command, 2]);
  }
}, 8 * LONG);

test.skipIf(process.platform === "win32")("a push that names nothing the remote lacks, or deletes, or only rehearses, is not verified", () => {
  const repo = branched();
  for (const command of ["git push origin HEAD", "git push", "git push origin good", "git push origin :bad", "git push --delete origin bad", "git push --dry-run origin bad", "git push -n origin bad", "git push origin nonesuch"]) {
    expect([command, hook(command, { cwd: repo })]).toEqual([command, expect.objectContaining({ status: 0, stderr: "" })]);
  }
}, 8 * LONG);

test.skipIf(process.platform === "win32")("a push that cannot be read as named refs is refused, with what to do", () => {
  const repo = branched();
  for (const command of ["git push --all origin", "git push --mirror", "git push origin 'refs/heads/*:refs/heads/*'"]) {
    const verdict = hook(command, { cwd: repo });
    expect([command, verdict.status, verdict.stderr]).toEqual([command, 2, expect.stringContaining("by name")]);
  }
});

// --- pushes through pre-commit and prek -----------------------------------

test("pre-commit and prek name one ref of a push, and none for a new root; the gate does not take that for the whole push", () => {
  const refs = { PRE_COMMIT_REMOTE_NAME: "origin" };
  // pre-commit exports no ref pair when the push starts at a root commit, and has read git's stdin by then.
  const [hit, ...more] = prePushHits(refs, "", "/r");
  expect(more).toEqual([]);
  expect(hit).toMatchObject({ kind: "push", dir: "/r", refuse: expect.stringContaining("install-hook") });
  // A bare hook is handed every ref on stdin and judges each.
  const [a, b, c] = ["a", "b", "c"].map((letter) => letter.repeat(40));
  const lines = `refs/heads/x ${a} refs/heads/x ${c}\nrefs/heads/y ${b} refs/heads/y ${"0".repeat(40)}\n`;
  expect(prePushHits({}, lines, "/r", "origin").map(({ sha, from, remote }) => [sha, from, remote])).toEqual([[a, c, "origin"], [b, "0".repeat(40), "origin"]]);
});

const GATE_STUB = (word) => `#!/bin/sh\n# ${word}\nexit 0\n`;
const hooksOf = (repo) => join(git(repo, "rev-parse", "--absolute-git-dir").trim(), "hooks");
const PRE_COMMIT_HOOK = "#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\n# ID: 138fd403232d2ddd5efb44317e38bf03\nexit 0\n";

test.skipIf(process.platform === "win32")("install-hook writes a bare pre-push hook, beside pre-commit's as its legacy hook, and never over another one", () => {
  const { repo } = pushable();
  const hooks = hooksOf(repo);
  mkdirSync(hooks, { recursive: true });
  const first = installHook(repo);
  expect(first.ok).toBe(true);
  const body = readFileSync(join(hooks, "pre-push"), "utf8");
  expect(body).toContain('pre-push "$@"');
  expect(installHook(repo).ok).toBe(true);
  expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(body);
  // pre-commit installed first: ours goes beside it, where its own hook runs it with git's stdin.
  writeFileSync(join(hooks, "pre-push"), PRE_COMMIT_HOOK, { mode: 0o755 });
  expect(installHook(repo).ok).toBe(true);
  expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(PRE_COMMIT_HOOK);
  expect(readFileSync(join(hooks, "pre-push.legacy"), "utf8")).toBe(body);
  // Somebody else's hook is theirs.
  writeFileSync(join(hooks, "pre-push"), GATE_STUB("mine"), { mode: 0o755 });
  rmSync(join(hooks, "pre-push.legacy"));
  const refused = installHook(repo);
  expect(refused.ok).toBe(false);
  expect(refused.message).toContain("pre-push");
  expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(GATE_STUB("mine"));
});

test.skipIf(process.platform === "win32")("the installed hook stops a push of two refs when the second carries the change", () => {
  const repo = branched();
  const remote = git(repo, "remote", "get-url", "origin").trim();
  expect(installHook(repo).ok).toBe(true);
  const env = { PATH, HOME: tmp, TMPDIR: tmp, PSTACK_VERIFY_CLAUDE: FAKE_CLI, GIT_CONFIG_GLOBAL: "/dev/null" };
  const push = (...refs) => spawnSync("git", ["-C", repo, "push", "origin", ...refs], { encoding: "utf8", env });
  const blocked = push("good:refs/heads/aa-good", "bad:refs/heads/zz-bad");
  expect(blocked.status).not.toBe(0);
  expect(blocked.stderr).toContain("verify gate:");
  expect(git(remote, "branch", "--list", "zz-bad", "aa-good")).toBe("");
  // The ref that carries nothing watched goes through the same hook.
  expect(push("good:refs/heads/aa-good").status).toBe(0);
}, 3 * LONG);

test.skipIf(process.platform === "win32")("install-hook does not wait for a stdin that stays open", async () => {
  const { repo } = pushable();
  const child = spawn(process.execPath, [GATE, "install-hook"], { cwd: repo, stdio: ["pipe", "pipe", "pipe"], env: { PATH, HOME: tmp, TMPDIR: tmp } });
  const code = await new Promise((done) => {
    const timer = setTimeout(() => (child.kill(), done("waited for stdin")), 5000);
    child.on("exit", (status) => (clearTimeout(timer), done(status)));
  });
  expect(code).toBe(0);
});

// Once a behavior check exists, a run limited to the surface tier says PARTIAL
// even when every surface check passed, because the behavior check was left
// out. The gate asks for the surface tier alone, so that is its pass.
test("a surface-only run with a behavior check on file is a pass for the gate, and a failing surface check still is not", async () => {
  const checks = tempDir();
  cpSync(ENGINE.checks, checks, { recursive: true });
  writeFileSync(join(checks, "B1-later.mjs"), 'export const title = "later";\nexport const tier = "behavior";\nexport const assertions = () => [];\n');
  const passed = await check(evidence({ ...ENGINE, checks }, { setup: { selection: { tier: "surface", flow: null } } }), checks);
  expect(passed.line).toBe("PARTIAL surface 2/2 | behavior NOT RUN | round 1");
  expect(judgeLine(passed.line).ok).toBe(true);
  const failed = await check(evidence({ ...ENGINE, checks }, { setup: { selection: { tier: "surface", flow: null } }, E2: { absent: true } }), checks);
  expect(failed.line).toStartWith("FAIL surface 1/2");
  expect(judgeLine(failed.line).ok).toBe(false);
});

// --- the code that judges ---------------------------------------------------

// The gate runs the verifier from the checkout it lives in, and points it at the
// commit pushed. An uncommitted edit to the verifier would then decide that
// commit's verdict, so the gate refuses to judge while there is one.
function judgeRepo() {
  const root = tempDir();
  mkdirSync(join(root, "tools/verify/checks"), { recursive: true });
  for (const file of ["tools/verify.mjs", "tools/plugin.mjs", "tools/verify/gate.mjs", "tools/verify/checks/S1-a.mjs", "README.md"]) writeFileSync(join(root, file), "x\n");
  return commitAll(root, "judge");
}

test("the verifier's own files, edited or added and not committed, are named; other files are not", () => {
  const root = judgeRepo();
  expect(judgeChanges(root)).toEqual([]);
  writeFileSync(join(root, "README.md"), "changed\n");
  expect(judgeChanges(root)).toEqual([]);
  writeFileSync(join(root, "tools/verify/checks/S1-a.mjs"), "weaker\n");
  writeFileSync(join(root, "tools/verify/checks/S2-new.mjs"), "new\n");
  writeFileSync(join(root, "tools/verify.mjs"), "edited\n");
  writeFileSync(join(root, "tools/plugin.mjs"), "edited\n");
  expect(judgeChanges(root).sort()).toEqual(["tools/plugin.mjs", "tools/verify.mjs", "tools/verify/checks/S1-a.mjs", "tools/verify/checks/S2-new.mjs"]);
  // Not a repository: nothing to compare with.
  expect(judgeChanges(tempDir())).toEqual([]);
});

test.skipIf(process.platform === "win32")("with the verifier edited and uncommitted, the verifier is not run and the push is blocked with the reason", async () => {
  const { repo } = pushable();
  watchedChange(repo);
  const sha = git(repo, "rev-parse", "HEAD").trim();
  const root = judgeRepo();
  writeFileSync(join(root, "tools/verify/checks/S1-a.mjs"), "weaker\n");
  const line = verifyCommit(repo, sha, { PATH, HOME: tmp, TMPDIR: tmp }, root);
  expect(line).toBe("DIRTY tools/verify/checks/S1-a.mjs");
  expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
  const verdict = await run({ line });
  expect(verdict.allow).toBe(false);
  expect(verdict.message).toMatch(/uncommitted.*tools\/verify\/checks\/S1-a\.mjs.*Commit or discard them/s);
  expect(verdict.message).toContain("Do not set it");
});
