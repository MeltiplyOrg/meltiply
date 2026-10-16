import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bootstrapHyperdrive,
  HyperdriveBootstrapError,
  originFromConnectionString,
} from "./hyperdrive-bootstrap.mjs";

const ids = {
  account: "a".repeat(32),
  authenticated: "b".repeat(32),
  system: "c".repeat(32),
};

const environment = {
  CLOUDFLARE_ACCOUNT_ID: ids.account,
  CLOUDFLARE_API_TOKEN: "cloudflare-secret-token",
  MELTIPLY_AUTHENTICATED_DATABASE_URL:
    "postgres://meltiply_rls:authenticated-secret@db.example.test/meltiply?sslmode=require",
  MELTIPLY_SYSTEM_DATABASE_URL:
    "postgres://meltiply_system:system-secret@db.example.test/meltiply?sslmode=verify-full",
};

function apiResponse(result, options = {}) {
  return new Response(
    JSON.stringify({
      errors: options.errors ?? [],
      result,
      ...(options.resultInfo ? { result_info: options.resultInfo } : {}),
      success: options.status ? options.status < 400 : true,
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: options.status ?? 200,
    },
  );
}

function fetchSequence(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ init, url: String(url) });
    const response = responses.shift();
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  };
  return { calls, fetchImpl };
}

test("database URL validation preserves only required Hyperdrive origin fields", () => {
  assert.deepEqual(
    originFromConnectionString(
      "postgresql://role%2Bname:secret%2Fvalue@db.example.test:5434/meltiply?sslmode=verify-ca",
    ),
    {
      database: "meltiply",
      host: "db.example.test",
      password: "secret/value",
      port: 5434,
      scheme: "postgres",
      user: "role+name",
    },
  );
  assert.throws(
    () =>
      originFromConnectionString("mysql://role:secret@db.example.test/meltiply?sslmode=require"),
    /only PostgreSQL/,
  );
  assert.throws(
    () => originFromConnectionString("postgres://role:secret@db.example.test/meltiply"),
    /sslmode/,
  );
});

test("bootstrap creates missing configurations without exposing credentials", async () => {
  const { calls, fetchImpl } = fetchSequence([
    apiResponse([]),
    apiResponse({ id: ids.authenticated }),
    apiResponse([]),
    apiResponse({ id: ids.system }),
  ]);

  assert.deepEqual(await bootstrapHyperdrive({ environment, fetchImpl }), {
    authenticated_hyperdrive_config_id: ids.authenticated,
    system_hyperdrive_config_id: ids.system,
  });
  assert.deepEqual(
    calls.map(({ init }) => init.method),
    ["GET", "POST", "GET", "POST"],
  );
  const requestBodies = calls.flatMap(({ init }) => (init.body ? [JSON.parse(init.body)] : []));
  assert.deepEqual(
    requestBodies.map(({ caching, name, origin_connection_limit }) => ({
      caching,
      name,
      origin_connection_limit,
    })),
    [
      {
        caching: { disabled: true },
        name: "meltiply-authenticated-staging",
        origin_connection_limit: 20,
      },
      {
        caching: { disabled: true },
        name: "meltiply-system-staging",
        origin_connection_limit: 20,
      },
    ],
  );
  assert.ok(
    calls.every(({ url }) =>
      ["authenticated-secret", "system-secret"].every((secret) => !url.includes(secret)),
    ),
  );
});

test("bootstrap discovers named configurations and rotates them with PUT", async () => {
  const { calls, fetchImpl } = fetchSequence([
    apiResponse([{ id: ids.authenticated, name: "meltiply-authenticated-staging" }]),
    apiResponse({ id: ids.authenticated }),
    apiResponse([{ id: ids.system, name: "meltiply-system-staging" }]),
    apiResponse({ id: ids.system }),
  ]);

  assert.deepEqual(await bootstrapHyperdrive({ environment, fetchImpl }), {
    authenticated_hyperdrive_config_id: ids.authenticated,
    system_hyperdrive_config_id: ids.system,
  });
  assert.deepEqual(
    calls.map(({ init }) => init.method),
    ["GET", "PUT", "GET", "PUT"],
  );
  assert.ok(calls[1].url.endsWith(`/${ids.authenticated}`));
  assert.ok(calls[3].url.endsWith(`/${ids.system}`));
});

test("bootstrap follows bounded lookup pagination before updating", async () => {
  const { calls, fetchImpl } = fetchSequence([
    apiResponse([], { resultInfo: { total_pages: 2 } }),
    apiResponse([{ id: ids.authenticated, name: "meltiply-authenticated-staging" }]),
    apiResponse({ id: ids.authenticated }),
    apiResponse([{ id: ids.system, name: "meltiply-system-staging" }]),
    apiResponse({ id: ids.system }),
  ]);

  await bootstrapHyperdrive({ environment, fetchImpl });
  assert.match(calls[0].url, /page=1/);
  assert.match(calls[1].url, /page=2/);
  assert.equal(calls[2].init.method, "PUT");
});

test("bootstrap accepts an empty zero-page lookup result", async () => {
  const { fetchImpl } = fetchSequence([
    apiResponse([], { resultInfo: { total_pages: 0 } }),
    apiResponse({ id: ids.authenticated }),
    apiResponse([], { resultInfo: { total_pages: 0 } }),
    apiResponse({ id: ids.system }),
  ]);

  assert.deepEqual(await bootstrapHyperdrive({ environment, fetchImpl }), {
    authenticated_hyperdrive_config_id: ids.authenticated,
    system_hyperdrive_config_id: ids.system,
  });
});

test("partial failure retains only the completed non-secret ID", async () => {
  const { fetchImpl } = fetchSequence([
    apiResponse([]),
    apiResponse({ id: ids.authenticated }),
    apiResponse([]),
    apiResponse(null, {
      errors: [{ code: 1001, message: "system-secret must never escape" }],
      status: 500,
    }),
  ]);

  await assert.rejects(bootstrapHyperdrive({ environment, fetchImpl }), (error) => {
    assert.ok(error instanceof HyperdriveBootstrapError);
    assert.deepEqual(error.partialResult, {
      authenticated_hyperdrive_config_id: ids.authenticated,
    });
    assert.doesNotMatch(error.message, /system-secret/);
    assert.match(error.message, /codes: 1001/);
    return true;
  });
});

test("bootstrap rejects ambiguous names, IDs, and database roles before writes", async () => {
  const duplicateLookup = fetchSequence([
    apiResponse([
      { id: ids.authenticated, name: "meltiply-authenticated-staging" },
      { id: "d".repeat(32), name: "meltiply-authenticated-staging" },
    ]),
  ]);
  await assert.rejects(
    bootstrapHyperdrive({
      environment,
      fetchImpl: duplicateLookup.fetchImpl,
    }),
    /multiple Hyperdrive configurations/,
  );
  assert.equal(duplicateLookup.calls.length, 1);

  await assert.rejects(
    bootstrapHyperdrive({
      environment: {
        ...environment,
        MELTIPLY_SYSTEM_DATABASE_URL: environment.MELTIPLY_AUTHENTICATED_DATABASE_URL,
      },
      fetchImpl: () => {
        throw new Error("network should not be called");
      },
    }),
    /distinct database roles/,
  );
  await assert.rejects(
    bootstrapHyperdrive({
      environment: {
        ...environment,
        MELTIPLY_AUTHENTICATED_HYPERDRIVE_ID: ids.authenticated,
        MELTIPLY_SYSTEM_HYPERDRIVE_ID: ids.authenticated,
      },
      fetchImpl: () => {
        throw new Error("network should not be called");
      },
    }),
    /IDs must differ/,
  );
});
