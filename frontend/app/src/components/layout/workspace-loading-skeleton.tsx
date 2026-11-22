import { useI18n } from "@/lib/i18n";

const RAIL_DESTINATIONS = ["posts", "channels"] as const;

const CONTENT_ROWS = Array.from({ length: 12 }, (_, index) => `row-${index + 1}`);

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
