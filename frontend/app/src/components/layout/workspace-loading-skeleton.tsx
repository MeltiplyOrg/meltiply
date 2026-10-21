import { useI18n } from "@/lib/i18n";

/** Rail destinations below the workspace heading: Posts and Channels. */
const RAIL_DESTINATIONS = ["posts", "channels"] as const;

/**
 * Content rows. Long enough to fill the workspace fold (~620px of rows, header,
 * and toolbar) so the resolved collection neither grows the page nor introduces
 * a scrollbar that was not already there; a longer collection scrolls either way.
 */
const CONTENT_ROWS = Array.from({ length: 12 }, (_, index) => `row-${index + 1}`);

/**
 * The workspace shell's own loading geometry.
 *
 * Renders the frame the authenticated workspace resolves to: the 252px rail with
 * its identity header and destination rows, the top bar with its breadcrumb and
 * jump-search pill, and a surface's titled header, toolbar, and rows. Rendered by
 * every pre-content state - the router's route Suspense boundary while a lazy
 * route chunk downloads, and the session gate while `/api/auth/get-session`
 * resolves - so the app opens on one shape instead of a centered notice, a
 * card grid, and then a shell.
 *
 * Geometry, colors, and the pulse live in `globals.css` (`.ws-boot*`), which
 * `index.html` renders as static markup for the pre-JavaScript first paint; this
 * component emits the same elements and classes so React's first commit repaints
 * identical pixels instead of swapping to a second placeholder.
 *
 * @returns An inert, screen-reader-announced boot frame that fills the viewport.
 */
export function WorkspaceLoadingSkeleton(): React.ReactElement {
  const { t } = useI18n();

  return (
    <div className="ws-boot" role="status" aria-busy="true">
      <span className="sr-only">{t("Loading Meltiply…")}</span>
      <div className="ws-boot-rail">
        <div className="ws-boot-brand">
          <i className="ws-boot-bar ws-boot-mark" />
          <i className="ws-boot-bar ws-boot-name" />
        </div>
        <i className="ws-boot-bar ws-boot-heading" />
        {RAIL_DESTINATIONS.map((destination) => (
          <i key={destination} className="ws-boot-bar ws-boot-nav" />
        ))}
      </div>
      <div className="ws-boot-main">
        <div className="ws-boot-topbar">
          <i className="ws-boot-bar ws-boot-crumb" />
          <i className="ws-boot-bar ws-boot-search" />
        </div>
        <div className="ws-boot-content">
          <i className="ws-boot-bar ws-boot-title" />
          <i className="ws-boot-bar ws-boot-subtitle" />
          <div className="ws-boot-toolbar">
            <i className="ws-boot-bar ws-boot-field" />
            <i className="ws-boot-bar ws-boot-chip" />
            <i className="ws-boot-bar ws-boot-chip" />
            <i className="ws-boot-bar ws-boot-switch" />
          </div>
          <div className="ws-boot-rows">
            {CONTENT_ROWS.map((row) => (
              <i key={row} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
