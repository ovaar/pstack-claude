// A typed /pstack:how. The harness resolves the command before any model
// call, and the CLI shows no Skill tool call for it. What is observable is
// the replayed command, and what the skill's body then makes the model do:
// its brief reaches a subagent's prompt. Two attempts, because a dispatch
// carries the subagent's own calls and costs the most of any session here.
import { attempts, BUG_FILES, HOW_COMMAND, LIMITS, typed } from "../scenes.mjs";

export const tier = "behavior";
export const runs = attempts(2, () => ({ args: [...LIMITS, "--input-format", "stream-json", "--replay-user-messages"], stdin: typed(HOW_COMMAND), files: BUG_FILES }));
