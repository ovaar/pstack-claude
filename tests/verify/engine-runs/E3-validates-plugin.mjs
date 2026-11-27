// A check over a subcommand's document, for the tests of the integrity rules
// that only such a run has. Not shipped.
export const title = "the validator reports a plugin";
export const tier = "surface";
export const commands = { validate: ["plugin", "validate", "--json", "<plugin>"] };

export function assertions({ trace, missing }) {
  const report = trace("validate").document() ?? missing("the validator's document");
  return [{ id: "valid", ok: report.success === true, saw: `success ${report.success}`, want: "success true" }];
}
