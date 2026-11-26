const names = ["REPORTING_POSTHOG_PROJECT_TOKEN", "REPORTING_POSTHOG_HOST"];

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
