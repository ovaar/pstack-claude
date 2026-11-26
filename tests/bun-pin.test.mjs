import { expect, test } from "bun:test";

import { bunPins, bunTooOld, bunTooOldMessage } from "../tools/bun-pin.mjs";

test("every setup-bun step in CI pins the same bun", () => {
  const pins = bunPins();
  expect(pins).toHaveLength(9);
  expect(new Set(pins).size).toBe(1);
});

test.each([
  ["1.3.14", "1.4.4", true],
  ["1.4.0", "1.4.4", false],
  ["1.4.5", "1.4.4", false],
  ["1.10.0", "1.9.2", false],
  ["2.0.0", "1.9.2", false],
  ["0.9.0", "1.0.0", true],
])("bun %s against the pin %s: too old is %p", (installed, pinned, tooOld) => {
  expect(bunTooOld(installed, pinned)).toBe(tooOld);
});

test("the message names both versions", () => {
  const message = bunTooOldMessage("1.3.14", "1.4.4");
  expect(message).toContain("1.4.4");
  expect(message).toContain("1.3.14");
});
