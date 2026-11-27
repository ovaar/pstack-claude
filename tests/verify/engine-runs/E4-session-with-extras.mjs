// A session that is given a variable and a file, for the tests of the rule
// that holds a run to what its check declares. Not shipped.
export const title = "the session is given a switch and a sheet";
export const tier = "surface";
export const args = { startup: ["--input-format", "stream-json"] };
export const env = { startup: { PSTACK_SESSION_HOOK: "off" } };
export const files = { startup: { "pstack-models.md": "session hook: off\n" } };

export function assertions({ trace }) {
  return [{ id: "ran", ok: trace("startup").hooks().length > 0, saw: "a hook response", want: "a hook response" }];
}
