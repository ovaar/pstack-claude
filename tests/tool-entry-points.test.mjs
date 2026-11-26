import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A worktree under /tmp on macOS reaches every tool through a symlink, and
// node leaves that symlink in argv[1].
test.each(["validate-skills.mjs", "sync.mjs"])("%s runs when its path crosses a symlink", (tool) => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-linked-repo-"));
  try {
    const linked = join(dir, "repo");
    symlinkSync(repoRoot, linked);
    const result = spawnSync("node", [join(linked, "tools", tool)], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 2, stdout: "" });
    expect(result.stderr).toContain(`tools/${tool}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each skill script carries its own entry guard, because a skill ships without
// tools/plugin.mjs. The arguments make each script print and exit without
// reading or writing anything outside the empty directory it runs in.
const skillScriptArgs = {
  "poteto-mode/scripts/check-playbooks.mjs": ["missing-dir"],
  "poteto-mode/scripts/codex-session-effort.mjs": [],
  "poteto-mode/scripts/worktree-audit.mjs": [],
  "reflect/scripts/claude-project-dir.mjs": ["missing-dir"],
  "reflect/scripts/find-transcript.mjs": [],
};

const skillsRoot = join(repoRoot, "plugins", "pstack", "skills");

function guardedSkillScripts() {
  return readdirSync(skillsRoot, { recursive: true })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(".mjs") && !path.includes("node_modules/"))
    .filter((path) => readFileSync(join(skillsRoot, path), "utf8").includes("process.argv[1]"))
    .sort();
}

test("every skill script with an entry guard has a symlink case", () => {
  // A script missing here needs a line in skillScriptArgs above, with
  // arguments that make it print and exit.
  expect(guardedSkillScripts()).toEqual(Object.keys(skillScriptArgs).sort());
});

test.each(Object.entries(skillScriptArgs))("%s runs when its path crosses a symlink", (script, args) => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-linked-repo-"));
  try {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const linked = join(dir, "repo");
    symlinkSync(repoRoot, linked);
    const env = { PATH: process.env.PATH, HOME: cwd };
    const run = (root) => {
      const result = spawnSync("node", [join(root, "plugins", "pstack", "skills", script), ...args], { cwd, env, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const direct = run(repoRoot);
    expect(direct.stdout + direct.stderr).not.toBe("");
    expect(run(linked)).toEqual(direct);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
