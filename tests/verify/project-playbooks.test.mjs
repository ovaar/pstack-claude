// The repository's project playbook anchors on the text of pstack's bundled
// playbooks. An upstream sync that rewords an anchored step leaves it
// pointing at nothing, and no workflow runs the playbook checker on this
// repository's own `.agents/playbooks`, and markdownlint ignores that folder.
// So this runs the repository's copy of the checker, as a user would, and
// fails with the checker's own lines.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPlaybooks } from "../../plugins/pstack/skills/poteto-mode/scripts/check-playbooks.mjs";

const repo = join(import.meta.dir, "../..");
const script = join(repo, "plugins/pstack/skills/poteto-mode/scripts/check-playbooks.mjs");

test("the checker finds no problem in the repository's playbooks", () => {
  expect(checkPlaybooks(repo)).toEqual([]);
});

test("the checker's command line passes at the repository root", () => {
  // A throwaway home keeps the developer's own ~/.agents/playbooks out of it.
  const home = mkdtempSync(join(tmpdir(), "pstack-verify-playbooks-"));
  try {
    const run = spawnSync("node", [script], { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("Every project playbook matches this pstack's playbooks.");
    expect(run.status).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
