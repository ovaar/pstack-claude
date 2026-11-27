// `claude plugin validate --json` is a subcommand: it reads the plugin
// directory and prints what the loader would provide, with no session and no
// model call. It reports every skill, agent, command and hook the directory
// holds, so a file that went missing shows as one fewer entry.
export const tier = "surface";

export const runs = [{ name: "validate", command: ["plugin", "validate", "--json", "<plugin>"] }];
