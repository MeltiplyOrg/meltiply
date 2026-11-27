import { describe, expect, it } from "vite-plus/test";

import { pseudoLocalize } from "./pseudo-locale";

describe("pseudoLocalize", () => {
  it.each([
    ["a word", "Dashboard", "⟦Dàshböàrd ~~~⟧"],
    ["capital vowels", "AEIOU", "⟦ÀËÏÖÜ ~~⟧"],
    ["a placeholder kept as written", "Open {name}", "⟦Öpën {name} ~~~~⟧"],
    ["an empty message", "", "⟦ ~⟧"],
  ])("%s", (_example, message, localized) => {
    expect(pseudoLocalize(message)).toEqual(localized);
  });
});
