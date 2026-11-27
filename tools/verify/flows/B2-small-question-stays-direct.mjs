// The mandate's other half: a one-line question is answered directly, with
// no detour through poteto-mode. Three attempts, and the check's rule.
import { attempts, LIMITS, QUESTION_PROMPT } from "../scenes.mjs";

export const tier = "behavior";
export const runs = attempts(3, () => ({ args: [...LIMITS, QUESTION_PROMPT] }));
