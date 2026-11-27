// The second check for the tests of the checker itself, so that one check
// can fail or be left out while another passes.
export const title = "the session ran a hook";
export const tier = "surface";
export const args = { startup: ["--input-format", "stream-json"] };

export function assertions({ trace, missing }) {
  const [hook] = trace("startup").hooks();
  if (!hook) missing("a hook_response");
  return [{ id: "hook", ok: hook.exitCode === 0, saw: `exit_code ${hook.exitCode}`, want: "exit_code 0" }];
}
