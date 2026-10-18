/**
 * Canonical component ownership tables shared by the `boundaries/*` oxlint
 * plugin and `lint/astro-ui-contract.mjs`, so React and Astro surfaces enforce
 * identical names. Contract: `frontend/shared/src/components/` is the only
 * component library — `ui`/`atoms`/`primitives` export flat as
 * `@meltiply/ui/<basename>`, `public/` as `@meltiply/ui/public/<basename>` —
 * and `frontend/app/src/components/{ui,atoms,primitives}` is retired, keeping
 * only the sanctioned app-coupled wrappers below. The sync test in
 * frontend/app asserts these tables equal the real tree.
 */

/** Converts platform separators so path matching works under oxlint anywhere. */
export function normalizePath(path) {
  return String(path ?? "").replace(/\\/g, "/");
}

/** Returns a file's stem without its final extension (`foo.test.tsx` → `foo.test`). */
export function stemOf(path) {
  const name = normalizePath(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Folds stems so `BrandMark`, `brand-mark`, and `brand_mark` all collide. */
export function normalizeStem(stem) {
  return stem.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Flat-export owners: normalized stem → dir under shared/src/components/. */
export const CANONICAL_FLAT_OWNERS = Object.freeze({
  alert: "ui",
  centeralertdialog: "ui",
  avatar: "ui",
  badge: "ui",
  button: "ui",
  card: "ui",
  cookienotice: "ui",
  centerdialog: "ui",
  dropdownmenu: "ui",
  empty: "ui",
  input: "ui",
  sidedialog: "ui",
  select: "ui",
  separator: "ui",
  sileo: "ui",
  skeleton: "ui",
  switch: "ui",
  tabs: "ui",
  textarea: "ui",
  tooltip: "ui",
  segmentedcontrol: "atoms",
  statuspill: "atoms",
  slidinghighlight: "primitives",
});

/**
 * Every normalized basename a canonical component claims — the flat names
 * above plus public adapters and shared-root `.tsx`/`.astro` components. Any
 * other frontend file/import target with one of these stems is a local clone.
 */
export const CANONICAL_COMPONENT_STEMS = Object.freeze({
  ...Object.fromEntries(Object.keys(CANONICAL_FLAT_OWNERS).map((stem) => [stem, true])),
  brandmark: true, // shared-root brand-mark.tsx and public/brand-mark.astro
  motionbootstrap: true, // public/motion-bootstrap.astro
  themebootstrap: true, // shared-root ThemeBootstrap.astro
  consentbootstrap: true, // shared-root ConsentBootstrap.astro
  // Retired/alternative dialog names: only CenterDialog, CenterAlertDialog,
  // and SideDialog exist, so these stems always mean a third dialog type.
  dialog: true,
  alertdialog: true,
  rightsidedialog: true,
  sheet: true,
  drawer: true,
});

/** Sanctioned files allowed to remain in the retired app component dirs. */
export const SANCTIONED_APP_COMPONENTS = Object.freeze({
  ui: Object.freeze({}),
  primitives: Object.freeze({
    "platform-icon": true,
    "sidebar-nav": true,
    "top-toolbar-button": true,
  }),
});
