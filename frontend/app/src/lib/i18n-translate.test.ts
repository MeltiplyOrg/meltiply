import { describe, expect, it } from "vite-plus/test";

import { translate } from "./i18n";

describe("translate", () => {
  it.each([
    ["en", "Settings"],
    ["es", "Configuración"],
  ] as const)("a catalog message in %s", (language, message) => {
    expect(translate(language, "Settings")).toEqual(message);
  });

  it.each(["es", "pt-BR", "fr", "de", "it", "zh", "vi"] as const)(
    "a message translated for %s",
    (language) => {
      expect(translate(language, "Settings")).not.toEqual("Settings");
    },
  );

  it("a message outside the catalog", () => {
    expect(translate("es", "Not a catalog key")).toEqual("Not a catalog key");
  });

  it.each([
    ["a text value", "es", "Expires {date}", { date: "mañana" }, "Caduca el mañana"],
    ["a numeric value", "en", "Week {week}", { week: 42 }, "Week 42"],
  ] as const)("%s", (_example, language, message, values, translated) => {
    expect(translate(language, message, values)).toEqual(translated);
  });

  it.each([
    ["the generic error copy", "An error has occurred.", "Se ha producido un error."],
    ["the hashtag placeholder", "#viral #shorts", "#viral #shorts"],
  ])("%s in Spanish", (_example, message, translated) => {
    expect(translate("es", message)).toEqual(translated);
  });
});
