import { PLATFORM_IDS } from "@meltiply/domain";
import { reportUnknownContractValue } from "./frontend-telemetry";
import { translate, type Language } from "./i18n";
import type { Asset, ConnectionStatus, PlatformAccount } from "@/types";

const SUPPORTED_PLATFORMS = PLATFORM_IDS;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/**
 * Contract connection states, kept separate from publication/Distribution
 * status. The exhaustive record means a new `ConnectionStatus` cannot be added
 * without extending the filter roster.
 */
const CONNECTION_STATUS_ROSTER = {
  connected: true,
  expiring: true,
  expired: true,
  revoked: true,
  reconnect_required: true,
} satisfies Record<ConnectionStatus, true>;

/** Every contract connection state, for the Channels filter options. */
export const CONNECTION_STATUSES = Object.keys(
  CONNECTION_STATUS_ROSTER,
) as readonly ConnectionStatus[];

const oauthOutcomes: Record<string, string> = {
  connected: "{platform} connected successfully.",
  connection_failed:
    "{platform} authorization succeeded, but the account could not be saved. Try connecting again.",
  consent_denied: "{platform} connection was cancelled before permission was granted.",
  missing_code:
    "{platform} connection could not be completed because the provider omitted its code.",
  provider_error:
    "{platform} connection could not be completed because the provider rejected the exchange.",
  provider_unavailable: "{platform} connection is not available yet.",
  selection_required:
    "{platform} authorization did not identify a single publishing account. Choose the intended account in the provider and try again.",
  state_invalid:
    "{platform} connection expired or could not be verified. Start again when the provider is available.",
};

const displayNames: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
};

/**
 * Returns the human-readable brand display name for a platform (e.g. "TikTok", "YouTube").
 * Logs telemetry if the platform identifier is unrecognized and returns the raw string as fallback.
 *
 * @param platform Platform identifier string.
 * @returns Human-readable platform name.
 */
export function platformDisplayName(platform: string): string {
  const displayName = displayNames[platform];
  if (displayName) return displayName;
  reportUnknownContractValue("platform", platform);
  return platform;
}

/**
 * Computes the list of supported platforms that are not currently connected by the workspace.
 *
 * @param connected Array of platform identifiers currently linked to the workspace.
 * @returns Filtered array of available `SupportedPlatform` IDs.
 */
export function getAvailablePlatforms(connected: string[]): SupportedPlatform[] {
  return SUPPORTED_PLATFORMS.filter((p) => !connected.includes(p));
}

/**
 * Evaluates whether an asset can be safely distributed to a target platform account.
 * Inspects connection health, publishing capability, accepted asset types, file size limits,
 * video duration limits, and MIME type restrictions based on provider capabilities.
 *
 * @param account Target platform account details including capability flags and limits.
 * @param asset Media or text asset proposed for publication.
 * @param language User interface language for localized error messages; defaults to "en".
 * @returns Localized failure reason if distribution is blocked, or `null` if the asset is compatible.
 */
export function distributionTargetBlockReason(
  account: PlatformAccount,
  asset: Asset,
  language: Language = "en",
): string | null {
  const name = platformDisplayName(account.platform);
  if (!["connected", "expiring"].includes(account.connection_status)) {
    return translate(language, "Reconnect {name} before publishing.", { name });
  }
  if (!account.capabilities.publish) {
    return translate(language, "{name} publishing is not available for this account.", { name });
  }
  if (!account.capabilities.asset_types.includes(asset.asset_type)) {
    return translate(language, "{name} does not accept {type} assets.", {
      name,
      type: translate(language, asset.asset_type),
    });
  }
  if (
    asset.file_size !== null &&
    account.capabilities.max_file_size !== null &&
    asset.file_size > account.capabilities.max_file_size
  ) {
    return translate(language, "This asset exceeds the {name} file-size limit.", { name });
  }
  if (
    asset.duration_sec !== null &&
    account.capabilities.max_video_duration_sec !== null &&
    asset.duration_sec > account.capabilities.max_video_duration_sec
  ) {
    return translate(language, "This asset exceeds the {name} video-duration limit.", { name });
  }
  if (
    asset.mime_type &&
    account.capabilities.accepted_mime_types.length > 0 &&
    !account.capabilities.accepted_mime_types.includes(asset.mime_type)
  ) {
    return translate(language, "{name} does not accept this asset's media type.", { name });
  }
  return null;
}

/**
 * Formats known OAuth outcomes, including non-Facebook destination-selection failures.
 * Interpolates the provider label in the chosen language; missing inputs and unknown/inherited
 * outcome keys return null. Pending account assignment is handled by the
 * dedicated assignment route, not a banner.
 */
export function oauthOutcomeMessage(
  outcome: string | null,
  provider: string | null,
  language: Language = "en",
): string | null {
  if (!outcome || !provider) return null;
  if (!Object.hasOwn(oauthOutcomes, outcome)) {
    reportUnknownContractValue("oauth_outcome", outcome);
    return null;
  }
  return translate(language, oauthOutcomes[outcome], { platform: platformDisplayName(provider) });
}
