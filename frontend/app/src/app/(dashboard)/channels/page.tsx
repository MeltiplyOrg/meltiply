import { ChannelsView } from "@/components/channels/channels-view";

/**
 * Connected platforms route hosting the `ChannelsView` at the canonical
 * `/channels` path. Real OAuth connect/disconnect flows through the
 * Meltiply platform endpoints; unsupported platforms render preview badges.
 *
 * @returns React element rendering the channels view.
 */
export default function ChannelsPage(): React.ReactElement {
  return <ChannelsView />;
}
