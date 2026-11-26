// Answers to 8b684b9: a declared dependency made the loader drop the whole
// plugin while the process still exited 0. That the plugin is the stage's, at
// the stage's version, is the integrity rules' part; this adds the loader's
// own error list.
export const title = "the plugin loads from the tree";
export const tier = "surface";

export function assertions({ trace, missing }) {
  const init = trace("context").init() ?? missing("the init event");
  const errors = init.pluginErrors.map((error) => `${error.type} (${error.plugin})`);
  return [
    {
      id: "plugin-errors",
      ok: errors.length === 0,
      saw: errors.length ? `plugin_errors ${errors.join(", ")}` : "no plugin_errors",
      want: "no plugin_errors",
    },
  ];
}
