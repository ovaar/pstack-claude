// An intent the mandate lists, said outright: the session calls the Skill
// tool for pstack:why. Measured on haiku (CLI 2.1.332), a why question that
// did not name the skill loaded it in 0 of 3 sessions, and a test-first
// request loaded pstack:tdd in 0 of 3, so this flow names the skill: it shows that a pstack skill loads by name, not that the
// mandate picks it unprompted.
import { attempts, BUG_FILES, LIMITS, WHY_PROMPT } from "../scenes.mjs";

export const tier = "behavior";
export const runs = attempts(3, () => ({ args: [...LIMITS, WHY_PROMPT], files: BUG_FILES }));
