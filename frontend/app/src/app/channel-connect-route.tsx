import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { AppProviders } from "@/app/providers";
import { ChannelAssignment } from "@/components/channels/channel-assignment";
import { WorkspaceProvider } from "@/context/workspace.context";
import { useSearchParams } from "@/lib/navigation";

/**
 * Blank OAuth landing surface: the provider callback redirects here with a
 * sealed assignment ticket, and the account/profile chooser occupies the page
 * directly. Success returns to Channels with the connected outcome; cancel or
 * an expired ticket returns without one.
 *
 * @returns The Channel assignment surface on an otherwise blank page.
 */
function ChannelConnectSurface(): React.ReactElement | null {
  const searchParams = useSearchParams();
  const selectionId = searchParams.get("selection_id");
  const provider = searchParams.get("provider");
  const navigate = useNavigate();
  const finished = useRef(false);

  useEffect(() => {
    if (!selectionId) navigate("/channels", { replace: true });
  }, [selectionId, navigate]);

  /** Leaves the blank surface exactly once, before a late close callback can navigate again. */
  const finish = useCallback(
    (connected: boolean) => {
      if (finished.current) return;
      finished.current = true;
      const outcome = connected
        ? `/channels?oauth=connected&provider=${encodeURIComponent(provider ?? "")}`
        : "/channels";
      navigate(outcome, { replace: true });
    },
    [navigate, provider],
  );

  const handleClose = useCallback(() => finish(false), [finish]);
  const handleSuccess = useCallback(() => finish(true), [finish]);

  return selectionId ? (
    <ChannelAssignment selectionId={selectionId} onClose={handleClose} onSuccess={handleSuccess} />
  ) : null;
}

/**
 * Authenticated route element for the post-OAuth Channel assignment handoff.
 *
 * Mounts the same query and workspace providers as the dashboard without its
 * navigation shell, so the assignment view's Brand Profile and account reads
 * behave identically while the page behind it stays blank.
 *
 * @returns Provider-wrapped Channel assignment surface.
 */
export default function ChannelConnectRoute(): React.ReactElement {
  return (
    <AppProviders>
      <WorkspaceProvider>
        <ChannelConnectSurface />
      </WorkspaceProvider>
    </AppProviders>
  );
}
