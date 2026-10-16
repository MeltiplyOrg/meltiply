import { useContext, useSyncExternalStore, type ReactElement } from "react";
import { Search as SearchIcon } from "lucide-react";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { MotionIcon, ThemeIcon } from "@meltiply/ui/preference-icons";
import { MotionPreferenceProvider, useMotionPreference } from "@meltiply/ui/motion-preference";
import { DocsThemeContext, DocsThemeProvider } from "./docs-theme";
/**
 * Hydration-safe mounted flag: the server snapshot is `false`, so preference
 * state renders identically through hydration and fills in on the first
 * client commit.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * Compact two-button toolbar in `sidebar.footer` (desktop aside + mobile
 * drawer): theme requests the shared landing-style reveal and asks the shared
 * consent-gated store to persist explicit intent; the live root still changes
 * in memory without consent. Low motion toggles its manual flag and OS reduce
 * always wins. Both toolbars use one persisted controller, so rapid toggles
 * reverse the active wave and announce the latest request during travel.
 * `themeOnly` reuses this controller and button on the landing header.
 */
function getThemeAction(mounted: boolean, dark: boolean): string {
  if (!mounted) return "Switch theme";
  return `Switch to ${dark ? "light" : "dark"} theme`;
}

function getMotionTitle(
  mounted: boolean,
  systemLowMotion: boolean,
  manualLowMotion: boolean,
): string {
  if (!mounted) return "Low motion";
  if (systemLowMotion) return "Low motion — your device is requesting reduced motion";
  if (manualLowMotion) return "Low motion on";
  return "Low motion";
}

function SearchPrefButton(): ReactElement {
  const { setOpenSearch } = useSearchContext();
  return (
    <button
      type="button"
      className="docs-pref-button"
      aria-label="Search documentation"
      title="Search documentation"
      onClick={() => setOpenSearch(true)}
    >
      <SearchIcon className="docs-pref-button-icon" aria-hidden="true" size={16} />
    </button>
  );
}

export function DocsPreferences({
  themeOnly = false,
  includeSearch = false,
}: {
  themeOnly?: boolean;
  includeSearch?: boolean;
}): ReactElement {
  const mounted = useMounted();
  const { manualLowMotion, setManualLowMotion, systemLowMotion } = useMotionPreference();

  const controller = useContext(DocsThemeContext);
  if (controller === null) throw new Error("DocsPreferences requires DocsThemeProvider");
  const { requestedTheme, resolvedTheme, toggleTheme } = controller;

  // The palette is read from the shared root controller; before hydration the
  // action name stays neutral, then follows the latest explicit or OS choice.
  const dark = mounted && (requestedTheme ?? resolvedTheme) === "dark";
  const themeAction = getThemeAction(mounted, dark);

  // The tooltip carries the OS-override explanation the app shows; the label
  // stays the control's plain name so both read correctly under OS reduce.
  const motionTitle = getMotionTitle(mounted, systemLowMotion, manualLowMotion);

  return (
    <div className="docs-prefs">
      {includeSearch && <SearchPrefButton />}
      <button
        type="button"
        className="docs-pref-button"
        aria-label={themeAction}
        title={themeAction}
        onClick={toggleTheme}
      >
        {/* The glyph follows the committed root palette via CSS; its action
            label follows pending intent, without a pre-hydration icon flash. */}
        <ThemeIcon className="docs-pref-button-icon" />
      </button>
      {!themeOnly && (
        <button
          type="button"
          className="docs-pref-button"
          aria-label="Low motion"
          aria-pressed={mounted && manualLowMotion}
          aria-description={
            mounted && systemLowMotion ? "Your device is requesting reduced motion" : undefined
          }
          title={motionTitle}
          onClick={() => setManualLowMotion(!manualLowMotion)}
        >
          {/* `html[data-low-motion]` and the OS media query pick the play/pause
            glyph via CSS, so it always shows effective (manual OR OS)
            motion state rather than just the manual flag. */}
          <MotionIcon className="docs-pref-button-icon" />
        </button>
      )}
    </div>
  );
}

/** Reuses docs' consent-gated theme controller and OS/manual motion on the homepage. */
export function LandingPreferences(): ReactElement {
  return (
    <MotionPreferenceProvider>
      <DocsThemeProvider>
        <DocsPreferences themeOnly />
      </DocsThemeProvider>
    </MotionPreferenceProvider>
  );
}
