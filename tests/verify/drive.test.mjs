// The driver starts what the runs list, as listed. It starts a session or one
// subcommand of the CLI that calls no model, and runs that share a config
// directory one after the other. A stand-in script is the CLI, so nothing here
// needs the real one.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { drive } from "../../tools/verify/drive.mjs";
import { plan } from "../../tools/verify/setup.mjs";
import { cleanup, tempDir } from "./harness.mjs";

afterEach(cleanup);

const parent = { PATH: "/usr/bin:/bin" };

// Prints its arguments, one to a line, and notes when it started and ended in
// its config directory, with a pause between so that overlap would show.
function stand() {
  const cli = join(tempDir(), "claude");
  writeFileSync(cli, '#!/bin/sh\necho start >> "$CLAUDE_CONFIG_DIR/log"\nfor arg in "$@"; do echo "$arg"; done\nsleep 0.15\necho end >> "$CLAUDE_CONFIG_DIR/log"\n', { mode: 0o755 });
  return cli;
}

const flows = (...runs) => [{ id: "S1", runs }];

test.skipIf(process.platform === "win32")("a subcommand is started with the stage's directories in place of the names, and with no session flag", async () => {
  const [stage, out] = [tempDir(), tempDir()];
  const runs = plan(flows({ name: "validate", command: ["plugin", "validate", "--json", "<plugin>"] }), tempDir(), parent, stage);
  await drive(runs, { cli: stand(), stage, plugin: join(stage, "plugins/pstack"), out });
  expect(readFileSync(join(out, "S1/validate.jsonl"), "utf8").split("\n")).toEqual(["plugin", "validate", "--json", join(stage, "plugins/pstack"), ""]);
  expect(JSON.parse(readFileSync(join(out, "S1/validate.sidecar.json"), "utf8")).argv.slice(1)).toEqual(["plugin", "validate", "--json", join(stage, "plugins/pstack")]);
});

test("a subcommand that is not the plugin validator is not started", async () => {
  const [stage, out] = [tempDir(), tempDir()];
  for (const command of [["plugin", "install", "pstack"], ["mcp", "list"], ["--bare"], []]) {
    const runs = plan(flows({ name: "x", command }), tempDir(), parent, stage);
    await expect(drive(runs, { cli: stand(), stage, plugin: join(stage, "plugins/pstack"), out })).rejects.toThrow("the driver starts no subcommand like");
  }
});

test.skipIf(process.platform === "win32")("runs that share a config directory go one after the other, and the others go side by side", async () => {
  const [stage, out] = [tempDir(), tempDir()];
  const runs = plan(flows({ name: "first", args: [] }, { name: "second", share: "first", args: [] }, { name: "alone", args: [] }), tempDir(), parent, stage);
  await drive(runs, { cli: stand(), stage, plugin: join(stage, "plugins/pstack"), out, jobs: 2 });
  const log = (name) => readFileSync(join(runs.find((run) => run.name === name).config, "log"), "utf8").trim().split("\n");
  expect(log("first")).toEqual(["start", "end", "start", "end"]);
  expect(log("alone")).toEqual(["start", "end"]);
});
