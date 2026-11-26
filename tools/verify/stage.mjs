// The digest of a stage. Setup records it when it builds the stage and the
// checker recomputes it, so a stage edited after the snapshot cannot pass.
// It lives outside setup.mjs because the checker may not import a module that
// starts processes.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function entries(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const rel = prefix + entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entries(path, `${rel}/`);
      const mode = (lstatSync(path).mode & 0o777).toString(8);
      // A link is hashed by where it points, never followed out of the stage.
      const content = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
      return [`${rel}\t${mode}\t${sha256(content)}\n`];
    });
}

// null when the directory is gone, which the checker reports as a moved tree.
export function stageHash(dir) {
  try {
    return sha256(entries(dir).join(""));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}
