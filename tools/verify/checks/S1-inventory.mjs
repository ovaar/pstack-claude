// Answers to f5f24cb and c42e947, the command trampolines, and to a skill or
// agent that drops out of the plugin without a loader error. What the loader
// provides, as `claude plugin validate --json` lists it, has to be what the
// stage holds: every skill directory, every agent under its frontmatter name,
// the hooks hooks/hooks.json registers, and no command at all, since a command
// file beside a skill shows twice in the slash menu. A skill or agent deleted
// from the tree leaves the lists equal, so the stage's own references are
// held to the list as well: each pstack: name that a skill, an agent or the
// mandate mentions must be one the loader provides, and the tree itself to an
// inventory written in this file, which catches the ones nothing names. S2 reads the skills from
// the session's init event, which leaves out the ones a user cannot invoke and
// the agents; this reads the loader's list.
export const title = "the plugin provides what the tree holds";
export const tier = "surface";
export const commands = { validate: ["plugin", "validate", "--json", "<plugin>"] };

// What the tree is meant to hold, written out. The loader's list and the
// stage's directories are read from the same tree, so a skill or agent deleted
// from it leaves them equal, and the references below catch only the ones some
// file names. A deletion is made on purpose, and this is where it shows: a
// skill or agent added or removed changes these lists in the same commit.
const SKILLS = [
  "architect", "arena", "automate-me", "babysit", "benchmark-checklist", "blast-radius", "bro", "correct",
  "create-formal-verification-skill", "create-verification-skill", "deslop", "figure-it-out", "fix-ci",
  "fix-merge-conflicts", "get-pr-comments", "how", "in-your-own-words", "interrogate", "ketchup",
  "ketchup-video", "maintain-formal-verification-skill", "maintain-verification-skill",
  "make-pr-easy-to-review", "no-comments", "poteto-help", "poteto-mode", "principle-attack-the-premise",
  "principle-boundary-discipline", "principle-build-the-lever", "principle-encode-lessons-in-structure",
  "principle-exhaust-the-design-space", "principle-experience-first", "principle-explain-the-number",
  "principle-fix-root-causes", "principle-foundational-thinking", "principle-guard-the-context-window",
  "principle-laziness-protocol", "principle-make-operations-idempotent",
  "principle-migrate-callers-then-delete-legacy-apis", "principle-minimize-reader-load",
  "principle-model-the-domain", "principle-never-block-on-the-human", "principle-outcome-oriented-execution",
  "principle-prove-it-works", "principle-redesign-from-first-principles",
  "principle-separate-before-serializing-shared-state", "principle-sequence-verifiable-units",
  "principle-subtract-before-you-add", "principle-test-behavior-not-implementation",
  "principle-type-system-discipline", "recall", "reflect", "reframe", "setup-pstack", "sharpen",
  "show-me-your-work", "statechart", "swarm", "tdd", "teach", "technical-writing",
  "thermo-nuclear-code-quality-review", "thermo-nuclear-review", "thermos", "typescript-best-practices",
  "unslop", "what-did-i-get-done", "why",
];
const AGENTS = [
  "comment-sicko", "poteto-agent", "thermo-nuclear-code-quality-review-subagent",
  "thermo-nuclear-review-subagent",
];

const PLUGIN = "plugins/pstack";
const MANDATE = `${PLUGIN}/hooks/session-start-context.md`;

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The `name` of a Markdown file's frontmatter, which is what the loader calls
// an agent. Only the block at the top of the file counts.
function frontmatterName(markdown) {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return block.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? null;
}

const flatten = (hooks) =>
  Object.entries(hooks?.hooks ?? {}).flatMap(([event, entries]) => (entries ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => `${event} | ${entry.matcher ?? ""} | ${hook.type} | ${hook.command}`)));

const difference = (want, seen) => ({ lacking: want.filter((each) => !seen.includes(each)), extra: seen.filter((each) => !want.includes(each)) });
const shown = (names) => (names.length ? names.join(", ") : "none");

function compare(id, what, seen, held) {
  const missing = held.filter((name) => !seen.includes(name));
  const extra = seen.filter((name) => !held.includes(name));
  const repeated = seen.filter((name, at) => seen.indexOf(name) !== at);
  return {
    id,
    ok: !missing.length && !extra.length && !repeated.length && seen.length === held.length,
    saw: missing.length || extra.length || repeated.length ? `${what}: ${seen.length} provided, ${held.length} in the tree; provided by no file: ${shown(extra)}; in the tree and not provided: ${shown(missing)}; listed twice: ${shown(repeated)}` : `${seen.length} ${what}, each the tree's`,
    want: `the ${what} of the tree, each once`,
  };
}

// The tree against the inventory above, as the loader would list them.
function inventory(name, skillDirs, agents) {
  const skills = difference(SKILLS.map((each) => `${name}:${each}`), skillDirs.map((dir) => `${name}:${dir}`));
  const held = difference(AGENTS.map((each) => `${name}:${each}`), agents);
  const ok = ![skills, held].some((each) => each.lacking.length || each.extra.length);
  const part = (what, { lacking, extra }) => `${what}: in the inventory and not the tree: ${shown(lacking)}; in the tree and not the inventory: ${shown(extra)}`;
  return {
    id: "inventory",
    ok,
    saw: ok ? `${skillDirs.length} skills and ${agents.length} agents, each in the inventory` : `${part("skills", skills)}; ${part("agents", held)}`,
    want: `the ${SKILLS.length} skills and ${AGENTS.length} agents the inventory in the check file lists; a deliberate change edits that list`,
  };
}

export function assertions({ trace, stage, missing }) {
  const report = trace("validate").document() ?? missing("the validator's document");
  const provides = report.provides ?? missing("the validator's provides list");
  const manifest = stage.text(`${PLUGIN}/.claude-plugin/plugin.json`) ?? missing("the stage's plugin manifest");
  const name = json(manifest)?.name ?? missing("the plugin's name in its manifest");

  const skillDirs = stage.list(`${PLUGIN}/skills`).filter((dir) => stage.text(`${PLUGIN}/skills/${dir}/SKILL.md`) !== null);
  const agentFiles = stage.list(`${PLUGIN}/agents`).filter((file) => file.endsWith(".md"));
  const skills = skillDirs.map((dir) => `${name}:${dir}`);
  const agents = agentFiles.map((file) => `${name}:${frontmatterName(stage.text(`${PLUGIN}/agents/${file}`) ?? "") ?? file.slice(0, -3)}`);
  const hooks = flatten(json(stage.text(`${PLUGIN}/hooks/hooks.json`) ?? "null"));
  const loaded = (provides.hooks ?? []).map((hook) => `${hook.event} | ${hook.matcher ?? ""} | ${hook.type} | ${hook.command}`);
  const errors = (report.manifest?.errors ?? []).map((error) => error.message ?? String(error));

  // What the tree's own words name.
  const texts = [...skillDirs.map((dir) => stage.text(`${PLUGIN}/skills/${dir}/SKILL.md`)), ...agentFiles.map((file) => stage.text(`${PLUGIN}/agents/${file}`)), stage.text(MANDATE)];
  const named = [...new Set(texts.flatMap((text) => (text ?? "").match(new RegExp(`${name}:[a-z0-9][a-z0-9-]*`, "g")) ?? []))].sort();
  const provided = [...(provides.skills ?? []), ...(provides.agents ?? [])];
  const dangling = named.filter((each) => !provided.includes(each));
  const commands = provides.commands ?? [];

  return [
    {
      id: "valid",
      ok: report.success === true && report.manifest?.type === "plugin" && errors.length === 0,
      saw: `success ${report.success}, manifest ${report.manifest?.type}, ${errors.length ? `errors ${errors.join("; ")}` : "no errors"}`,
      want: "success true, a plugin manifest, no errors",
    },
    compare("skills", "skills", provides.skills ?? [], skills),
    compare("agents", "agents", provides.agents ?? [], agents),
    compare("hooks", "hooks", loaded, hooks),
    inventory(name, skillDirs, agents),
    {
      id: "no-commands",
      ok: commands.length === 0,
      saw: commands.length ? `commands provided: ${commands.join(", ")}` : "no command provided",
      want: "no command: a skill is its own slash command",
    },
    {
      id: "references",
      ok: named.length > 0 && dangling.length === 0,
      saw: !named.length ? `no ${name}: name in the skills, agents or mandate` : dangling.length ? `named in the tree and not provided: ${dangling.join(", ")}` : `${named.length} ${name}: names in the skills, agents and mandate, each provided`,
      want: `at least 1 ${name}: name in the skills, agents and mandate, each a skill or agent the loader provides`,
    },
  ];
}
