import type { TimeString } from "better-auth/plugins";

/** Device-authorization flow for the first-party CLI client; scope grants no extra capability. */
export interface BetterAuthDeviceAuthorizationConfig {
  clientId: string;
  expiresIn: TimeString;
  interval: TimeString;
  /** Absolute browser verification URL, same-origin with `baseURL`. */
  verificationUri: string;
}

export function deviceAuthorizationSettings(
  device: BetterAuthDeviceAuthorizationConfig | undefined,
  baseURL: string | undefined,
): BetterAuthDeviceAuthorizationConfig | undefined {
  if (!device) return undefined;
  const clientId = device.clientId.trim();
  if (!clientId) {
    throw new TypeError("device authorization requires an exact client identifier");
  }
  const verificationUrl = new URL(device.verificationUri);
  if (baseURL && verificationUrl.origin !== new URL(baseURL).origin) {
    throw new TypeError("device authorization verification URI must be same-origin");
  }
  return { ...device, clientId, verificationUri: verificationUrl.href };
}
