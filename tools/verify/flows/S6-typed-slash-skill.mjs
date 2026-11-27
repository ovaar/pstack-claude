// A slash command typed for a skill is resolved by the harness before any
// model call. With `--replay-user-messages` the CLI echoes each message it
// expands, as a user event wrapped in <command-name>, and the session's
// transcript holds the skill's own text under a line naming its directory.
// A skill the user cannot invoke is refused with a fixed answer, and a name
// no skill has is passed on as typed. Logged out, each of these ends with
// cost 0 and no real model: measured 69 names in 1.4 s. One message is typed
// for every skill directory the stage holds, and for a name it has none of.
export const tier = "surface";

const typed = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

export const runs = [
  {
    name: "typed",
    args: ["--input-format", "stream-json", "--replay-user-messages"],
    stdin: ({ skills }) => [...skills, "does-not-exist"].map((name) => typed(`/pstack:${name}`)).join(""),
  },
];
