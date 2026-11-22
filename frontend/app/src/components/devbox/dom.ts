export function elementSelector(element: Element, skipClasses: readonly string[] = []): string {
  const classes = Array.from(element.classList)
    .filter((name) => !skipClasses.includes(name))
    .slice(0, 3)
    .join(".");
  return classes ? `${element.tagName.toLowerCase()}.${classes}` : element.tagName.toLowerCase();
}

export function ensureStyleTag(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
