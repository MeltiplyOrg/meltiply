const placeholderSegmentsPattern = /(\{[^}]*\})/g;
const vowelsPattern = /[aeiouAEIOU]/g;

export const pseudoLocaleEvent = "meltiply:pseudo-locale";

let enabled = false;

const accents: Record<string, string> = {
  a: "à",
  e: "ë",
  i: "ï",
  o: "ö",
  u: "ü",
  A: "À",
  E: "Ë",
  I: "Ï",
  O: "Ö",
  U: "Ü",
};

export function pseudoLocalize(message: string): string {
  const transformed = message
    .split(placeholderSegmentsPattern)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? segment
        : segment.replace(vowelsPattern, (char) => accents[char] ?? char),
    )
    .join("");
  const padding = "~".repeat(Math.max(1, Math.round(message.length * 0.35)));
  return `⟦${transformed} ${padding}⟧`;
}

export function isPseudoLocalized(): boolean {
  return enabled;
}

export function setPseudoLocalization(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  window.dispatchEvent(new CustomEvent(pseudoLocaleEvent));
}
