// Answers to f5f24cb and c42e947, the command trampolines, and to a skill or
// agent that drops out of the plugin without a loader error. What the loader
// provides, as `claude plugin validate --json` lists it, has to be what the
// stage holds: every skill directory, every agent under its frontmatter name,
// the hooks hooks/hooks.json registers, and no command at all, since a command
// file beside a skill shows twice in the slash menu. A skill or agent deleted
// from the tree leaves the lists equal, so the stage's own references are
// held to the list as well: each pstack: name that a skill, an agent or the
// mandate mentions must be one the loader provides. S2 reads the skills from
// the session's init event, which leaves out the ones a user cannot invoke and
// the agents; this reads the loader's list.
export const title = "the plugin provides what the tree holds";
export const tier = "surface";
export const commands = { validate: ["plugin", "validate", "--json", "<plugin>"] };

const PLUGIN = "plugins/pstack";
const MANDATE = `${PLUGIN}/hooks/session-start-context.md`;

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The `name` of a Markdown file's frontmatter, which is what the loader calls
// an agent. Only the block at the top of the file counts.
function frontmatterName(markdown) {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return block.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? null;
}

const flatten = (hooks) =>
  Object.entries(hooks?.hooks ?? {}).flatMap(([event, entries]) => (entries ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => `${event} | ${entry.matcher ?? ""} | ${hook.type} | ${hook.command}`)));

const shown = (names) => (names.length ? names.join(", ") : "none");

function compare(id, what, seen, held) {
  const missing = held.filter((name) => !seen.includes(name));
  const extra = seen.filter((name) => !held.includes(name));
  const repeated = seen.filter((name, at) => seen.indexOf(name) !== at);
  return {
    id,
    ok: !missing.length && !extra.length && !repeated.length && seen.length === held.length,
    saw: missing.length || extra.length || repeated.length ? `${what}: ${seen.length} provided, ${held.length} in the tree; provided by no file: ${shown(extra)}; in the tree and not provided: ${shown(missing)}; listed twice: ${shown(repeated)}` : `${seen.length} ${what}, each the tree's`,
    want: `the ${what} of the tree, each once`,
  };
}

export function assertions({ trace, stage, missing }) {
  const report = trace("validate").document() ?? missing("the validator's document");
  const provides = report.provides ?? missing("the validator's provides list");
  const manifest = stage.text(`${PLUGIN}/.claude-plugin/plugin.json`) ?? missing("the stage's plugin manifest");
  const name = json(manifest)?.name ?? missing("the plugin's name in its manifest");

  const skillDirs = stage.list(`${PLUGIN}/skills`).filter((dir) => stage.text(`${PLUGIN}/skills/${dir}/SKILL.md`) !== null);
  const agentFiles = stage.list(`${PLUGIN}/agents`).filter((file) => file.endsWith(".md"));
  const skills = skillDirs.map((dir) => `${name}:${dir}`);
  const agents = agentFiles.map((file) => `${name}:${frontmatterName(stage.text(`${PLUGIN}/agents/${file}`) ?? "") ?? file.slice(0, -3)}`);
  const hooks = flatten(json(stage.text(`${PLUGIN}/hooks/hooks.json`) ?? "null"));
  const loaded = (provides.hooks ?? []).map((hook) => `${hook.event} | ${hook.matcher ?? ""} | ${hook.type} | ${hook.command}`);
  const errors = (report.manifest?.errors ?? []).map((error) => error.message ?? String(error));

  // What the tree's own words name.
  const texts = [...skillDirs.map((dir) => stage.text(`${PLUGIN}/skills/${dir}/SKILL.md`)), ...agentFiles.map((file) => stage.text(`${PLUGIN}/agents/${file}`)), stage.text(MANDATE)];
  const named = [...new Set(texts.flatMap((text) => (text ?? "").match(new RegExp(`${name}:[a-z0-9][a-z0-9-]*`, "g")) ?? []))].sort();
  const provided = [...(provides.skills ?? []), ...(provides.agents ?? [])];
  const dangling = named.filter((each) => !provided.includes(each));
  const commands = provides.commands ?? [];

  return [
    {
      id: "valid",
      ok: report.success === true && report.manifest?.type === "plugin" && errors.length === 0,
      saw: `success ${report.success}, manifest ${report.manifest?.type}, ${errors.length ? `errors ${errors.join("; ")}` : "no errors"}`,
      want: "success true, a plugin manifest, no errors",
    },
    compare("skills", "skills", provides.skills ?? [], skills),
    compare("agents", "agents", provides.agents ?? [], agents),
    compare("hooks", "hooks", loaded, hooks),
    {
      id: "no-commands",
      ok: commands.length === 0,
      saw: commands.length ? `commands provided: ${commands.join(", ")}` : "no command provided",
      want: "no command: a skill is its own slash command",
    },
    {
      id: "references",
      ok: named.length > 0 && dangling.length === 0,
      saw: !named.length ? `no ${name}: name in the skills, agents or mandate` : dangling.length ? `named in the tree and not provided: ${dangling.join(", ")}` : `${named.length} ${name}: names in the skills, agents and mandate, each provided`,
      want: `at least 1 ${name}: name in the skills, agents and mandate, each a skill or agent the loader provides`,
    },
  ];
}
