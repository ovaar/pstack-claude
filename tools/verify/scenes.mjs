// What the model-tier flows give a session to work on: a tiny project, the
// prompts, and the limits every such session runs under. The flows share them
// so that two of them can differ in one condition and nothing else. The
// check files do not import this module (a check imports nothing), so each
// one states the arguments it accepts for itself, and the shape test in
// roles.test.mjs fails when a flow and its check disagree.

// Three files and a signature the others call: the kind of change the
// mandate sends to poteto-mode.
export const BUG_FILES = {
  "cart.py": 'def total(items):\n    return round(sum(i["price"] * i["qty"] for i in items) * 1.21, 2)\n',
  "tax.py": "def with_tax(amount, rate=0.21):\n    return round(amount * (1 + rate), 2)\n",
  "totals.py": "from cart import total\nfrom tax import with_tax\n\n\ndef order_total(items):\n    return with_tax(total(items))\n",
};

export const BUG_PROMPT =
  "There is a bug whose cause is not yet known: order totals are sometimes off by one cent. The logic spans cart.py, tax.py and totals.py, and the fix will likely change a function signature the other files call. Begin working on it now.";
export const QUESTION_PROMPT = "Which git command lists the files changed in the last commit? Answer in one sentence.";
export const WHY_PROMPT = "Use the pstack:why skill to explain why totals.py applies tax after summing the cart instead of per line item.";
export const HOW_COMMAND = "/pstack:how how does order_total in totals.py work?";

// One turn is enough to see a session's first move, and the cost cap stops a
// session that runs on. `--setting-sources ''` and `--strict-mcp-config` keep
// the person's own settings, hooks and MCP servers out of a session signed in
// with their login, and nothing is written to their transcripts.
export const LIMITS = ["--max-turns", "1", "--max-budget-usd", "0.03", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"];

export const TIMEOUT_MS = 120_000;
export const attempts = (count, make) => Array.from({ length: count }, (_, at) => ({ name: `attempt-${at + 1}`, timeoutMs: TIMEOUT_MS, ...make(at + 1) }));

export const typed = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
