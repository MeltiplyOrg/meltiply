import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertDatabaseRoles } from "../lib/database-roles.mjs";
import { readBoundedJsonResponse } from "../release/release-http.mjs";

const MAXIMUM_API_RESPONSE_BYTES = 1024 * 1024;

const cloudflareId = /^[a-f0-9]{32}$/i;
const environmentName = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Retrieves a non-empty trimmed environment variable, throwing if missing or empty.
 *
 * @param {string} name - Environment variable key name
 * @param {Record<string, string | undefined>} environment - Environment lookup source
 * @returns {string} Trimmed non-empty string value
 * @throws {Error} If the environment variable is unset or contains only whitespace
 */
function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Validates that a given identifier string conforms to Cloudflare's 32-character hexadecimal format.
 *
 * @param {string} value - Identifier candidate string
 * @param {string} name - Contextual label for error reporting
 * @returns {string} The validated 32-character hexadecimal ID
 * @throws {TypeError} If the identifier format is invalid
 */
function validatedId(value, name) {
  if (!cloudflareId.test(value)) {
    throw new TypeError(`${name} must be a 32-character Cloudflare ID`);
  }
  return value;
}

/**
 * Parses a PostgreSQL connection string into a Cloudflare Hyperdrive origin payload.
 * Enforces postgres/postgresql protocols, requires credentials and target database,
 * and ensures TLS protection by requiring sslmode to be 'require', 'verify-ca', or 'verify-full'.
 *
 * @param {string} connectionString - Complete PostgreSQL connection URI
 * @returns {{ database: string, host: string, password: string, port: number, scheme: string, user: string }} Hyperdrive origin specification
 * @throws {TypeError} If the URL protocol, parameters, credentials, or SSL mode fail validation
 */
export function originFromConnectionString(connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new TypeError("Hyperdrive bootstrap accepts only PostgreSQL URLs");
  }
  if (!url.username || !url.password || !url.hostname || url.pathname === "/") {
    throw new TypeError("database URL must include user, password, host, and database");
  }
  const sslmode = url.searchParams.get("sslmode");
  if (!["require", "verify-ca", "verify-full"].includes(sslmode ?? "")) {
    throw new TypeError("staging database URL must set sslmode=require, verify-ca, or verify-full");
  }
  return {
    database: decodeURIComponent(url.pathname.slice(1)),
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: Number(url.port || 5432),
    scheme: "postgres",
    user: decodeURIComponent(url.username),
  };
}

export class HyperdriveBootstrapError extends Error {
  /**
   * Initializes a Hyperdrive bootstrap error with optional cause and partial provisioning state.
   *
   * @param {string} message - Error description
   * @param {object} [options={}] - Options containing cause and partialResult
   * @param {Error} [options.cause] - Underlying root cause error
   * @param {Record<string, string>} [options.partialResult] - Any successfully provisioned config IDs prior to failure
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "HyperdriveBootstrapError";
    this.partialResult = options.partialResult ?? {};
  }
}

/**
 * Creates a sanitized Error instance for Cloudflare API failures.
 * Extracts safe numeric or alphanumeric error codes while preventing secret leakage from response payloads.
 *
 * @param {string} operation - Name of the attempted operation (e.g., 'configuration lookup', 'create')
 * @param {Response} response - HTTP response object
 * @param {object} [envelope] - Parsed Cloudflare response envelope
 * @returns {Error} Formatted error including HTTP status and safe error codes
 */
function safeApiError(operation, response, envelope) {
  const codes = Array.isArray(envelope?.errors)
    ? envelope.errors
        .map((error) => error?.code)
        .filter((code) => typeof code === "number" || /^[A-Z0-9_-]+$/i.test(code))
    : [];
  const codeSuffix = codes.length > 0 ? `; codes: ${codes.join(",")}` : "";
  return new Error(`Cloudflare Hyperdrive ${operation} failed (${response.status})${codeSuffix}`);
}

/**
 * Dispatches an HTTP request to the Cloudflare API with bounded JSON envelope parsing.
 * Fails closed if the HTTP status is not ok or if the response envelope indicates failure.
 *
 * @param {typeof fetch} fetchImpl - HTTP fetch implementation
 * @param {string | URL} url - Target Cloudflare API endpoint
 * @param {string} operation - Human-readable operation name for error reporting
 * @param {RequestInit} init - Fetch request options
 * @returns {Promise<object>} Parsed Cloudflare API JSON response envelope
 * @throws {Error} If network fails, size limits are exceeded, or API reports failure
 */
async function apiRequest(fetchImpl, url, operation, init) {
  const response = await fetchImpl(url, init);
  let envelope;
  try {
    envelope = await readBoundedJsonResponse(
      response,
      MAXIMUM_API_RESPONSE_BYTES,
      "Cloudflare Hyperdrive response",
    );
  } catch {
    throw safeApiError(operation, response);
  }
  if (!response.ok || !envelope?.success) {
    throw safeApiError(operation, response, envelope);
  }
  return envelope;
}

/**
 * Queries the Cloudflare Hyperdrive API across paginated results to discover an existing configuration ID by name.
 * Fails closed if multiple configurations share the exact same name to prevent ambiguous binding.
 *
 * @param {object} params - Discovery parameters
 * @param {string} params.accountId - Cloudflare account ID
 * @param {string} params.apiToken - Cloudflare API bearer token
 * @param {typeof fetch} params.fetchImpl - Fetch implementation
 * @param {string} params.name - Target Hyperdrive configuration name
 * @returns {Promise<string | undefined>} Discovered 32-character configuration ID, or undefined if not found
 * @throws {Error} If API response or pagination is malformed, or if duplicate configs exist
 */
async function existingConfigurationId({ accountId, apiToken, fetchImpl, name }) {
  const endpoint = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs`,
  );
  endpoint.searchParams.set("per_page", "50");
  const matches = [];
  let page = 1;
  let totalPages = 1;
  do {
    endpoint.searchParams.set("page", String(page));
    const envelope = await apiRequest(fetchImpl, endpoint, "configuration lookup", {
      headers: { Authorization: `Bearer ${apiToken}` },
      method: "GET",
    });
    if (!Array.isArray(envelope.result)) {
      throw new Error("Cloudflare Hyperdrive lookup returned an invalid result");
    }
    matches.push(...envelope.result.filter((configuration) => configuration?.name === name));
    totalPages = Number(envelope.result_info?.total_pages ?? 1);
    if (!Number.isInteger(totalPages) || totalPages < 0 || totalPages > 1000) {
      throw new Error("Cloudflare Hyperdrive lookup returned invalid pagination");
    }
    page += 1;
  } while (page <= totalPages);

  if (matches.length > 1) {
    throw new Error(
      `multiple Hyperdrive configurations are named ${name}; provide the exact existing ID`,
    );
  }
  return matches.length === 1 ? validatedId(matches[0].id, `discovered ${name} ID`) : undefined;
}

/**
 * Creates or updates a Cloudflare Hyperdrive configuration.
 * Disables query caching (caching.disabled = true) to maintain transactional freshness,
 * sets origin connection limit to 20, and returns the validated resulting ID.
 *
 * @param {object} params - Upsert options
 * @param {string} params.accountId - Cloudflare account ID
 * @param {string} params.apiToken - Cloudflare API token
 * @param {string} [params.existingId] - Optional explicit known configuration ID
 * @param {typeof fetch} params.fetchImpl - Fetch implementation
 * @param {string} params.name - Target Hyperdrive configuration name
 * @param {object} params.origin - Origin database connection details
 * @returns {Promise<string>} Validated 32-character Hyperdrive configuration ID
 * @throws {Error} If API call fails or resulting ID is malformed
 */
async function upsertConfiguration({ accountId, apiToken, existingId, fetchImpl, name, origin }) {
  const resolvedId =
    existingId ?? (await existingConfigurationId({ accountId, apiToken, fetchImpl, name }));
  const endpoint = resolvedId
    ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs/${resolvedId}`
    : `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs`;
  const operation = resolvedId ? "update" : "create";
  const envelope = await apiRequest(fetchImpl, endpoint, operation, {
    method: resolvedId ? "PUT" : "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      caching: { disabled: true },
      name,
      origin,
      origin_connection_limit: 20,
    }),
  });
  return validatedId(envelope.result?.id, `${name} result ID`);
}

/**
 * Bootstraps Cloudflare Hyperdrive configurations for both authenticated and system database roles.
 * Verifies both protected login identities and role attributes before provider access,
 * enforces distinct config IDs, and provides partial recovery state after an upsert failure.
 *
 * @param {object} [options={}] - Execution options
 * @param {Function} [options.clientFactory] - PostgreSQL client factory for role verification
 * @param {Record<string, string | undefined>} [options.environment=process.env] - Environment variable lookup
 * @param {typeof fetch} [options.fetchImpl=fetch] - HTTP fetch implementation
 * @returns {Promise<{ authenticated_hyperdrive_config_id: string, system_hyperdrive_config_id: string }>} Resulting config IDs
 * @throws {HyperdriveBootstrapError} If provisioning fails, capturing any partially provisioned IDs
 * @throws {TypeError} If role constraints or ID formats are violated
 */
export async function bootstrapHyperdrive(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const accountId = validatedId(
    required("CLOUDFLARE_ACCOUNT_ID", environment),
    "CLOUDFLARE_ACCOUNT_ID",
  );
  const apiToken = required("CLOUDFLARE_API_TOKEN", environment);
  const targetEnvironment = environment.MELTIPLY_ENVIRONMENT?.trim() || "staging";
  if (!environmentName.test(targetEnvironment)) {
    throw new TypeError("MELTIPLY_ENVIRONMENT must be a lowercase alphanumeric slug");
  }

  const authenticatedOrigin = originFromConnectionString(
    required("MELTIPLY_AUTHENTICATED_DATABASE_URL", environment),
  );
  const systemOrigin = originFromConnectionString(
    required("MELTIPLY_SYSTEM_DATABASE_URL", environment),
  );
  if (authenticatedOrigin.user === systemOrigin.user) {
    throw new TypeError(
      "authenticated and system Hyperdrive configurations must use distinct database roles",
    );
  }

  const authenticatedExistingId = environment.MELTIPLY_AUTHENTICATED_HYPERDRIVE_ID?.trim();
  const systemExistingId = environment.MELTIPLY_SYSTEM_HYPERDRIVE_ID?.trim();
  if (authenticatedExistingId) {
    validatedId(authenticatedExistingId, "MELTIPLY_AUTHENTICATED_HYPERDRIVE_ID");
  }
  if (systemExistingId) {
    validatedId(systemExistingId, "MELTIPLY_SYSTEM_HYPERDRIVE_ID");
  }
  if (authenticatedExistingId && systemExistingId && authenticatedExistingId === systemExistingId) {
    throw new TypeError("authenticated and system Hyperdrive IDs must differ");
  }
  await assertDatabaseRoles({ clientFactory: options.clientFactory, environment });

  let authenticatedId;
  try {
    authenticatedId = await upsertConfiguration({
      accountId,
      apiToken,
      existingId: authenticatedExistingId,
      fetchImpl,
      name: `meltiply-authenticated-${targetEnvironment}`,
      origin: authenticatedOrigin,
    });
  } catch (cause) {
    throw new HyperdriveBootstrapError(
      `authenticated Hyperdrive bootstrap failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      { cause },
    );
  }

  let systemId;
  try {
    systemId = await upsertConfiguration({
      accountId,
      apiToken,
      existingId: systemExistingId,
      fetchImpl,
      name: `meltiply-system-${targetEnvironment}`,
      origin: systemOrigin,
    });
  } catch (cause) {
    throw new HyperdriveBootstrapError(
      `system Hyperdrive bootstrap failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      {
        cause,
        partialResult: {
          authenticated_hyperdrive_config_id: authenticatedId,
        },
      },
    );
  }

  if (authenticatedId === systemId) {
    throw new HyperdriveBootstrapError(
      "authenticated and system Hyperdrive results must be distinct",
      {
        partialResult: {
          authenticated_hyperdrive_config_id: authenticatedId,
          system_hyperdrive_config_id: systemId,
        },
      },
    );
  }
  return {
    authenticated_hyperdrive_config_id: authenticatedId,
    system_hyperdrive_config_id: systemId,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await bootstrapHyperdrive()));
  } catch (cause) {
    if (cause instanceof HyperdriveBootstrapError && Object.keys(cause.partialResult).length > 0) {
      console.log(JSON.stringify({ status: "partial", ...cause.partialResult }));
    }
    console.error(cause instanceof Error ? cause.message : "Hyperdrive bootstrap failed");
    process.exitCode = 1;
  }
}
