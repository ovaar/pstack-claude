// Answers to 8b684b9: a declared dependency made the loader drop the whole
// plugin while the process still exited 0. That the plugin is the stage's, at
// the stage's version, is the integrity rules' part. This adds what the
// loader says of itself: its error list, and whether what it loaded is what
// the tree holds. It reports no error for a skill whose SKILL.md it cannot
// read or that has no description, and leaves it out of init.skills; and it
// lists a file under commands/ as a slash command.
export const title = "the plugin loads from the tree";
export const tier = "surface";
export const args = { context: ["/context"] };

const SKILLS = "plugins/pstack/skills";
// init.skills leaves these out whether they loaded or not.
const hidden = (skill) => /^user-invocable:\s*false\s*$/im.test(skill.split(/^---\s*$/m)[1] ?? "");

export function assertions({ trace, stage, missing }) {
  const init = trace("context").init() ?? missing("the init event");
  const errors = init.pluginErrors.map((error) => `${error.type} (${error.plugin})`);
  const inTree = stage
    .list(SKILLS)
    .map((name) => ({ name, skill: stage.text(`${SKILLS}/${name}/SKILL.md`) }))
    .filter(({ skill }) => skill !== null);
  const visible = inTree.filter(({ skill }) => !hidden(skill)).map(({ name }) => name);
  const dropped = visible.filter((name) => !init.skills.includes(`pstack:${name}`));
  const stray = init.slashCommands.filter((name) => name.startsWith("pstack:") && !inTree.some((each) => `pstack:${each.name}` === name));
  return [
    {
      id: "plugin-errors",
      ok: errors.length === 0,
      saw: errors.length ? `plugin_errors ${errors.join(", ")}` : "no plugin_errors",
      want: "no plugin_errors",
    },
    {
      id: "skills",
      ok: dropped.length === 0,
      saw: dropped.length ? `skills in the tree and not in init.skills: ${dropped.join(", ")}` : `${visible.length} skills in the tree, each in init.skills`,
      want: "every skill in the tree that a user can invoke, in init.skills",
    },
    {
      id: "commands",
      ok: stray.length === 0,
      saw: stray.length ? `slash commands with no skill in the tree: ${stray.join(", ")}` : "no pstack: slash command beside the tree's skills",
      want: "no pstack: slash command beside the tree's skills",
    },
  ];
}
