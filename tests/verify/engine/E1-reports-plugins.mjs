// A check for the tests of the checker itself. It is not shipped: the tests
// that hold the integrity rules, the verdicts and the evidence in place must
// not change when a shipped check does.
export const title = "the session reports its plugins";
export const tier = "surface";
export const args = { context: ["/context"] };

export function assertions({ trace, missing }) {
  const init = trace("context").init() ?? missing("the init event");
  return [{ id: "plugins", ok: init.plugins.length > 0, saw: `${init.plugins.length} plugins in init`, want: "at least 1 plugin in init" }];
}
