// The same subcommand on the stage root validates the marketplace manifest
// there, which is the file `/plugin marketplace add` reads. Measured on CLI
// 2.1.332: it parses the manifest and warns when an entry's version is not
// the plugin's, and it does not look for the directory the entry's source
// names, so the check reads that from the stage itself.
export const tier = "surface";

export const runs = [{ name: "validate", command: ["plugin", "validate", "--json", "<stage>"] }];
