// A typed /pstack:how. The harness resolves the command before any model
// call, and the CLI shows no Skill tool call for it. What is observable is
// the replayed command, and what the skill's body then makes the model do:
// its brief reaches a subagent's prompt. Three attempts, and the dispatch is
// refused by a hook once it is in the stream, because a subagent's calls are
// outside --max-turns and one made eight of them.
import { attempts, BUG_FILES, HOW_COMMAND, LIMITS, REFUSE_DISPATCH, typed } from "../scenes.mjs";

export const tier = "behavior";
export const runs = attempts(3, () => ({ args: [...LIMITS, "--settings", REFUSE_DISPATCH, "--input-format", "stream-json", "--replay-user-messages"], stdin: typed(HOW_COMMAND), project: BUG_FILES }));
