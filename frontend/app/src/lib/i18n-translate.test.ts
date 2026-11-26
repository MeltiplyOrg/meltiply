import { describe, expect, it } from "vite-plus/test";

import { supportedLanguages, translate } from "./i18n";

const languages = supportedLanguages.map(({ code }) => code);

describe("translate", () => {
  it.each([
    ["en", "Settings"],
    ["es", "Configuración"],
  ] as const)("a catalog message in %s", (language, message) => {
    expect(translate(language, "Settings")).toEqual(message);
  });

  it.each(languages.filter((code) => code !== "en"))("a message translated for %s", (language) => {
    expect(translate(language, "Settings")).not.toEqual("Settings");
  });

  it.each(languages)("a message outside the %s catalog", (language) => {
    expect(translate(language, "Not a catalog key")).toEqual("Not a catalog key");
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
