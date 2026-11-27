// Answers to f5f24cb, c42e947 and 5debf23: a slash command typed for one of
// the plugin's skills has to be resolved by the harness, with no model call.
// For every skill a user can invoke, the CLI echoes the message wrapped in
// <command-name> and the session transcript holds the skill's own text under
// a line naming the stage's skill directory; for one it hides from users it
// answers with a fixed refusal; and a name no skill has is passed on as
// typed, which the transcript records as an unknown command. The three are
// told apart by structured records, never by what a model said, and every
// exchange costs nothing. The principle leaves, which a skill reaches for in
// its own text, must be among the refused. A skill that stopped being resolved turns up as
// passed on, or as missing its transcript line.
export const title = "a typed slash command is resolved before any model call";
export const tier = "surface";
export const args = { typed: ["--input-format", "stream-json", "--replay-user-messages"] };

const SKILLS = "plugins/pstack/skills";
const UNKNOWN = "does-not-exist";
// The skills a skill reaches for in its own text, which are no commands to
// type: each is hidden from users, and typing one is refused.
const LEAVES = "principle-";
const REFUSED = "This skill can only be invoked by Claude, not directly by users.";
const BASE = "Base directory for this skill: ";

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const hidden = (skill) => /^user-invocable:\s*false\s*$/im.test(skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "");
const shown = (names) => (names.length ? names.join(", ") : "none");

// What is in a list and not in the other, as the two lists of an assertion.
function difference(want, seen) {
  return { lacking: want.filter((name) => !seen.includes(name)), extra: seen.filter((name) => !want.includes(name)), twice: seen.filter((name, at) => seen.indexOf(name) !== at) };
}

function account(id, what, want, seen, held) {
  const { lacking, extra, twice } = difference(want, seen);
  const ok = !lacking.length && !extra.length && !twice.length;
  return {
    id,
    ok,
    saw: ok ? `${seen.length} ${what}` : `${what}: ${lacking.length} lacking (${shown(lacking)}); ${extra.length} not the tree's (${shown(extra)}); ${twice.length} twice (${shown(twice)})`,
    want: held,
  };
}

export function assertions({ trace, stage, missing }) {
  const session = trace("typed");
  const manifest = stage.text("plugins/pstack/.claude-plugin/plugin.json") ?? missing("the stage's plugin manifest");
  const plugin = json(manifest)?.name ?? missing("the plugin's name in its manifest");
  const tree = stage
    .list(SKILLS)
    .map((name) => ({ name, skill: stage.text(`${SKILLS}/${name}/SKILL.md`) }))
    .filter(({ skill }) => skill !== null);
  const open = tree.filter(({ skill }) => !hidden(skill)).map(({ name }) => name);
  const closed = tree.filter(({ skill }) => hidden(skill)).map(({ name }) => name);

  const exchanges = session.exchanges();
  const lines = session.transcriptLines();
  if (!lines.length) missing("the session transcript");

  const wrapped = exchanges.map((each) => each.replay?.match(/<command-name>\/([^<]*)<\/command-name>/)?.[1]).filter(Boolean);
  const prefix = `${plugin}:`;
  const resolved = wrapped.filter((command) => command.startsWith(prefix)).map((command) => command.slice(prefix.length));

  const expanded = lines
    .filter((line) => line.type === "user" && line.isMeta && line.text?.split("\n")[0].startsWith(BASE))
    .map((line) => line.text.split("\n")[0].slice(BASE.length))
    .filter((path) => path.startsWith(`${stage.plugin}/skills/`))
    .map((path) => path.slice(`${stage.plugin}/skills/`.length));
  const typedPlain = lines.filter((line) => line.type === "user" && !line.isMeta).map((line) => line.text);

  const refusals = exchanges.filter((each) => each.resultText?.startsWith(REFUSED));
  const raw = exchanges.map((each) => each.replay).filter((text) => text !== null && !text.includes("<command-name>"));
  const rawSkills = raw.filter((text) => tree.some(({ name }) => text === `/${prefix}${name}`));
  const fallbacks = lines.filter((line) => line.attachment === "unknown_command_fallback").length;
  const asked = open.length + closed.length + 1;
  const leaves = tree.map(({ name }) => name).filter((name) => name.startsWith(LEAVES));
  const exposed = leaves.filter((name) => open.includes(name) || resolved.includes(name) || expanded.includes(name));

  return [
    {
      id: "answered",
      ok: exchanges.length === asked,
      saw: `${exchanges.length} results for the messages typed`,
      want: `${asked} results, one for each of the ${open.length} skills a user can invoke, the ${closed.length} it cannot and 1 unknown name`,
    },
    account("resolved", "skills echoed as a command", open, resolved, `each of the ${open.length} skills a user can invoke, echoed once as <command-name>/${prefix}NAME</command-name>`),
    account("expanded", "skills expanded from the stage", open, expanded, `each of the ${open.length} skills a user can invoke, expanded once from ${stage.plugin}/skills/NAME in the transcript`),
    {
      id: "refused",
      ok: closed.length > 0 ? refusals.length === closed.length && refusals.every((each) => each.turns === 0 && !each.isError) && closed.every((name) => typedPlain.includes(`/${prefix}${name}`)) : refusals.length === 0,
      saw: `${refusals.length} refusals (turns ${shown([...new Set(refusals.map((each) => each.turns))].map(String))}); ${closed.filter((name) => typedPlain.includes(`/${prefix}${name}`)).length} of ${closed.length} hidden skills typed`,
      want: `${closed.length} refusals with no turn, one for each skill a user cannot invoke, and none of them expanded`,
    },
    {
      id: "leaves-refused",
      ok: leaves.length > 0 && exposed.length === 0,
      saw: !leaves.length ? `no ${LEAVES}* skill in the tree` : exposed.length ? `a user can invoke ${exposed.length} of ${leaves.length} ${LEAVES}* skills: ${exposed.join(", ")}` : `${leaves.length} ${LEAVES}* skills, none invocable by a user`,
      want: `at least 1 ${LEAVES}* skill, none of them invocable by a user`,
    },
    {
      id: "passed-through",
      ok: raw.filter((text) => text === `/${prefix}${UNKNOWN}`).length === 1 && fallbacks === 1,
      saw: `${raw.filter((text) => text === `/${prefix}${UNKNOWN}`).length} replays of /${prefix}${UNKNOWN} as typed; ${fallbacks} unknown_command_fallback in the transcript`,
      want: `/${prefix}${UNKNOWN} replayed as typed once and recorded as an unknown command once`,
    },
    {
      id: "none-unresolved",
      ok: rawSkills.length === 0,
      saw: rawSkills.length ? `passed on as typed: ${rawSkills.join(", ")}` : "no skill of the tree passed on as typed",
      want: "no skill of the tree passed on as typed",
    },
  ];
}
