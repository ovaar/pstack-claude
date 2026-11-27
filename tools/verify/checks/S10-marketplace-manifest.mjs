// The manifest at the repository root is what `/plugin marketplace add`
// reads, so it is the file most users meet first. The loader's validator
// accepts a manifest whose source names a directory that is not there, and
// only warns when an entry's version is not the plugin's, so this reads both
// from the stage as well: the manifest parses, its entry names the plugin
// directory the CLI was given and the version the tree holds, and the
// validator has no error and no warning.
export const title = "the marketplace manifest names the plugin the tree holds";
export const tier = "surface";
export const commands = { validate: ["plugin", "validate", "--json", "<stage>"] };

const MANIFEST = ".claude-plugin/marketplace.json";
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// `./plugins/pstack` and `plugins/pstack/` name one directory.
const directory = (source) => (typeof source === "string" ? source.replace(/^(\.\/)+/, "").replace(/\/+$/, "") : null);

export function assertions({ trace, stage, missing }) {
  const report = trace("validate").document() ?? missing("the validator's document");
  const text = stage.text(MANIFEST) ?? missing("the stage's marketplace manifest");
  const marketplace = json(text);
  const issues = [...(report.manifest?.errors ?? []), ...(report.manifest?.warnings ?? [])].map((issue) => `${issue.path ?? "manifest"}: ${issue.message ?? String(issue)}`);

  // The entries that name the plugin the CLI loads: the stage's plugin
  // directory is where --plugin-dir points, so an entry's source resolves
  // against the stage root to that same directory.
  const entries = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
  const dir = stage.plugin.slice(stage.root.length + 1);
  const entry = entries.find((each) => directory(each?.source) === dir);
  const held = json(stage.text(`${dir}/${PLUGIN_MANIFEST}`) ?? "null");
  const version = (stage.text("VERSION") ?? "").trim();
  const versions = [entry?.version, held?.version, version];

  return [
    {
      id: "valid",
      ok: report.success === true && report.manifest?.type === "marketplace" && issues.length === 0,
      saw: `success ${report.success}, manifest ${report.manifest?.type}, ${issues.length ? issues.join("; ") : "no errors and no warnings"}`,
      want: "success true, a marketplace manifest, no errors and no warnings",
    },
    {
      id: "parses",
      ok: marketplace !== null && typeof marketplace === "object" && typeof marketplace.name === "string" && entries.length > 0,
      saw: marketplace === null ? `${MANIFEST} is not JSON` : `${entries.length} plugins listed in ${MANIFEST}`,
      want: `${MANIFEST} is JSON with a name and at least one plugin`,
    },
    {
      id: "source",
      ok: entry !== undefined && held !== null,
      saw: entry === undefined ? `sources ${entries.map((each) => JSON.stringify(each?.source)).join(", ") || "none"}` : `source ${entry.source}, ${held === null ? `no ${PLUGIN_MANIFEST} there` : `${dir}/${PLUGIN_MANIFEST} there`}`,
      want: `an entry whose source is the plugin directory ${dir}, which holds ${PLUGIN_MANIFEST}`,
    },
    {
      id: "name",
      ok: entry !== undefined && typeof held?.name === "string" && entry.name === held.name,
      saw: `entry name ${JSON.stringify(entry?.name)}, plugin manifest name ${JSON.stringify(held?.name)}`,
      want: "the entry's name is the plugin manifest's",
    },
    {
      id: "version",
      ok: versions.every((each) => each === version) && version !== "",
      saw: `entry version ${JSON.stringify(entry?.version)}, plugin manifest version ${JSON.stringify(held?.version)}, VERSION ${JSON.stringify(version)}`,
      want: "the entry's version, the plugin manifest's and VERSION are one",
    },
  ];
}
