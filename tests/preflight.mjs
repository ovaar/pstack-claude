// Names the fix when the copy of Pi in plugins/ that the Pi tests load is not
// installed. Without it those tests fail with only "Cannot find module". This
// does not stop the run: a run that never loads Pi, such as the Windows session
// hooks job, which installs only the root dependencies, still passes. The
// note prints first and again after the last test, below the errors.
import { afterAll } from "bun:test";
import { fileURLToPath } from "node:url";

import { bunPins, bunTooOld, bunTooOldMessage } from "../tools/bun-pin.mjs";

const extensionDir = fileURLToPath(new URL("../plugins/pstack/pi/", import.meta.url));

function piInstalled() {
  try {
    Bun.resolveSync("@earendil-works/pi-coding-agent", extensionDir);
    return true;
  } catch {
    return false;
  }
}

// Unlike the Pi note, this stops the run: under an older bun the suite reports
// dozens of failures that point at the lockfile, not at the real cause.
const [pinned] = bunPins();
if (pinned && bunTooOld(Bun.version, pinned)) {
  console.error(bunTooOldMessage(Bun.version, pinned));
  process.exit(1);
}

// Nested `bun test` runs that tests spawn inherit the variable and stay quiet.
if (!process.env.PSTACK_PI_NOTE_SHOWN && !piInstalled()) {
  process.env.PSTACK_PI_NOTE_SHOWN = "1";
  const note =
    'The copy of Pi in plugins/ is not installed, so tests that load the Pi extension fail with "Cannot find module". Run:\n  bun install --frozen-lockfile --cwd plugins\n(see CONTRIBUTING.md, "Before you open a PR")';
  console.warn(note);
  afterAll(() => console.warn(`\n${note}`));
}
