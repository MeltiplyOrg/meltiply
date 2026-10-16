/**
 * Shared DOM helpers for DevBox tooling modules.
 *
 * Several inspectors need the same two primitives: a compact `tag.class`
 * selector hint for reporting, and an idempotent `<style>` injector for
 * overlay/highlight rules. Centralizing them keeps the audit modules focused
 * on their own logic.
 */

/**
 * Builds a compact `tag.class` selector hint for an element. Not a full
 * unique path — just enough to locate the element in devtools. `skipClasses`
 * filters out marker utilities (e.g. `animate-pulse`) that would otherwise
 * crowd out the meaningful classes.
 */
export function elementSelector(element: Element, skipClasses: readonly string[] = []): string {
  const classes = Array.from(element.classList)
    .filter((name) => !skipClasses.includes(name))
    .slice(0, 3)
    .join(".");
  return classes ? `${element.tagName.toLowerCase()}.${classes}` : element.tagName.toLowerCase();
}

/**
 * Injects a `<style>` element with the given id once; subsequent calls are
 * no-ops. Used by every DevBox overlay so repeated toggles never stack
 * duplicate style tags.
 */
export function ensureStyleTag(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
