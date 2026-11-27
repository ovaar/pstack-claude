// What setup records about a stage and the checker recomputes, so a stage
// edited after the snapshot cannot pass. It lives outside setup.mjs because
// the checker may not import a module that starts processes.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function walk(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const here = { rel: prefix + entry.name, path: join(dir, entry.name), entry };
      return entry.isDirectory() ? [here, ...walk(here.path, `${here.rel}/`)] : [here];
    });
}

// null when the directory is gone, which the checker reports as a moved tree.
function orGone(read) {
  try {
    return read();
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

function fileLine({ rel, path, entry }) {
  const mode = (lstatSync(path).mode & 0o777).toString(8);
  // A link is hashed by where it points, never followed out of the stage.
  const content = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
  return `${rel}\t${mode}\t${sha256(content)}\n`;
}

// What the stage holds: every file's path, mode and content.
export const stageHash = (dir) =>
  orGone(() =>
    sha256(
      walk(dir)
        .filter(({ entry }) => !entry.isDirectory())
        .map(fileLine)
        .join(""),
    ),
  );

// When each entry last changed, by the file system's own clock. A file that
// is changed for the length of a session and then put back has its old hash
// and a new change time, and no caller can set that time back.
export const stageSeal = (dir) => orGone(() => sha256([{ rel: ".", path: dir }, ...walk(dir)].map(({ rel, path }) => `${rel}\t${lstatSync(path, { bigint: true }).ctimeNs}\n`).join("")));
