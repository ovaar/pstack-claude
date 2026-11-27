// The mandate's first criterion, met plainly: a bug in three files with a
// signature to change. A session that has the mandate should load
// pstack:poteto-mode before it edits anything. A model is not deterministic,
// so the flow samples three attempts and its check holds them to a rule.
import { attempts, BUG_FILES, BUG_PROMPT, LIMITS } from "../scenes.mjs";

export const tier = "behavior";
export const runs = attempts(3, () => ({ args: [...LIMITS, BUG_PROMPT], project: BUG_FILES }));
