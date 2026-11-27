// B1's prompt and project with the session hook switched off. If the
// sessions no longer route, the mandate is what routed them in B1.
import { attempts, BUG_FILES, BUG_PROMPT, LIMITS } from "../scenes.mjs";

export const tier = "behavior";
export const runs = attempts(3, () => ({ args: [...LIMITS, BUG_PROMPT], project: BUG_FILES, env: { PSTACK_SESSION_HOOK: "off" } }));
