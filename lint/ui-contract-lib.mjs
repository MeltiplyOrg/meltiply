const nonAlphanumericPattern = /[^a-z0-9]/g;

export function normalizePath(path) {
  return String(path ?? "").replaceAll("\\", "/");
}

export function stemOf(path) {
  const name = normalizePath(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function normalizeStem(stem) {
  return stem.toLowerCase().replace(nonAlphanumericPattern, "");
}

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
  popover: "ui",
  sidedialog: "ui",
  select: "ui",
  sileo: "ui",
  skeleton: "ui",
  switch: "ui",
  tabs: "ui",
  textarea: "ui",
  tooltip: "ui",
  segmentedcontrol: "atoms",
  statuspill: "atoms",
  rollingcount: "atoms",
  slidinghighlight: "primitives",
});

export const CANONICAL_COMPONENT_STEMS = Object.freeze({
  ...Object.fromEntries(Object.keys(CANONICAL_FLAT_OWNERS).map((stem) => [stem, true])),
  brandmark: true, // shared-root brand-mark.tsx and public/brand-mark.astro
  motionbootstrap: true, // public/motion-bootstrap.astro
  themebootstrap: true, // shared-root ThemeBootstrap.astro
  consentbootstrap: true, // shared-root ConsentBootstrap.astro
  dialog: true,
  alertdialog: true,
  rightsidedialog: true,
  sheet: true,
  drawer: true,
});

export const SANCTIONED_APP_COMPONENTS = Object.freeze({
  ui: Object.freeze({}),
  primitives: Object.freeze({
    "platform-icon": true,
    "sidebar-nav": true,
    "top-toolbar-button": true,
  }),
});
