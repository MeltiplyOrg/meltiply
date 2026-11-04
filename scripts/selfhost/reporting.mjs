/**
 * Improvement-reporting bindings for the self-hosted runtime.
 *
 * The released image carries the maintainer's publishable PostHog project token
 * and matching ingestion origin, so an operator needs no PostHog account. An
 * explicit non-empty operator value wins; an empty or absent value uses the
 * image default, and when neither exists the binding stays unset, which makes
 * both reporting categories honestly unavailable instead of failing startup.
 *
 * Nothing here is a secret in the cryptographic sense: the project token
 * authorizes event ingestion only and grants no project administration.
 */

/** Bindings this module may set; every one is optional deployment input. */
const names = ["REPORTING_POSTHOG_PROJECT_TOKEN", "REPORTING_POSTHOG_HOST"];

/**
 * Resolves the reporting bindings for one runtime.
 *
 * @param {object} imageDefaults - Destination baked into this image
 * @param {string} [imageDefaults.host] - Ingestion origin, empty when unprovisioned
 * @param {string} [imageDefaults.project_token] - Publishable token, empty when unprovisioned
 * @param {Record<string, string | undefined>} environment - Operator environment
 * @returns {Record<string, string>} Only the bindings that have a usable value
 */
export function reportingBindings(imageDefaults, environment) {
  const defaults = {
    REPORTING_POSTHOG_HOST: imageDefaults?.host ?? "",
    REPORTING_POSTHOG_PROJECT_TOKEN: imageDefaults?.project_token ?? "",
  };
  const resolved = {};
  for (const name of names) {
    const configured = environment[name]?.trim();
    const value =
      configured === undefined || configured === "" ? defaults[name].trim() : configured;
    if (value) resolved[name] = value;
  }
  return resolved;
}
