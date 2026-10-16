import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  renderEndpointReadiness,
  run,
  validateReadinessCatalog,
  verifyPromotionEvidence,
} from "./endpoint-readiness.mjs";

const contractRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openApiPath = resolve(contractRoot, "openapi.yaml");
const metadataPath = resolve(contractRoot, "operation-readiness.json");

async function loadCanonicalInputs() {
  const [openApiSource, metadataSource] = await Promise.all([
    readFile(openApiPath, "utf8"),
    readFile(metadataPath, "utf8"),
  ]);
  return {
    catalog: JSON.parse(metadataSource),
    openApi: YAML.parse(openApiSource),
  };
}

const digest = `sha256:${"a".repeat(64)}`;
const immutableEvidence = (kind) => ({
  digest,
  url: `https://ci.example.test/artifacts/release-01/${kind}.json`,
});

function promotionEvidence() {
  return {
    acceptance: immutableEvidence("acceptance"),
    conformance: immutableEvidence("conformance"),
    release: immutableEvidence("release"),
    smoke: immutableEvidence("smoke"),
    telemetry: immutableEvidence("telemetry"),
  };
}

function fetchedEvidence(operationId, overrides = {}) {
  const bodies = new Map();
  const references = {};
  for (const kind of ["release", "conformance", "smoke", "telemetry", "acceptance"]) {
    const artifact = {
      kind,
      operationIds: [operationId],
      result: "passed",
      schemaVersion: 1,
      ...overrides[kind],
    };
    const body = JSON.stringify(artifact);
    const url = `https://ci.example.test/artifacts/release-01/${kind}.json`;
    references[kind] = {
      digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      url,
    };
    bodies.set(url, body);
  }
  return { bodies, references };
}

function fetchFrom(bodies) {
  return async (url) => {
    const body = bodies.get(url);
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body, {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}

test("coverage validation rejects missing and extra operation metadata", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const missing = structuredClone(catalog);
  delete missing.operations.getHealth;
  assert.throws(() => validateReadinessCatalog(openApi, missing), /missing: getHealth/);

  const extra = structuredClone(catalog);
  extra.operations.unknownOperation = structuredClone(extra.operations.getReadiness);
  assert.throws(() => validateReadinessCatalog(openApi, extra), /extra: unknownOperation/);
});

test("staging-ready promotion requires immutable release, conformance, smoke, and telemetry evidence", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  for (const missingKind of ["release", "conformance", "smoke", "telemetry"]) {
    const candidate = structuredClone(catalog);
    const evidence = promotionEvidence();
    delete evidence[missingKind];
    candidate.operations.getHealth = {
      ...candidate.operations.getHealth,
      promotionEvidence: evidence,
      state: "staging-ready",
    };

    assert.throws(
      () => validateReadinessCatalog(openApi, candidate),
      new RegExp(`without immutable .*${missingKind} evidence`),
    );
  }
});

test("accepted promotion retains staging evidence and requires immutable acceptance evidence", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  for (const missingKind of ["release", "conformance", "smoke", "telemetry", "acceptance"]) {
    const candidate = structuredClone(catalog);
    const evidence = promotionEvidence();
    delete evidence[missingKind];
    candidate.operations.getHealth = {
      ...candidate.operations.getHealth,
      promotionEvidence: evidence,
      state: "accepted",
    };

    assert.throws(
      () => validateReadinessCatalog(openApi, candidate),
      new RegExp(`without immutable .*${missingKind} evidence`),
    );
  }
});

test("promotion evidence rejects mutable or ambiguous artifact references", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const invalidDigest = structuredClone(catalog);
  invalidDigest.operations.getHealth = {
    ...invalidDigest.operations.getHealth,
    promotionEvidence: {
      ...promotionEvidence(),
      smoke: {
        digest: "latest",
        url: "https://ci.example.test/artifacts/latest/smoke.json",
      },
    },
    state: "staging-ready",
  };
  assert.throws(() => validateReadinessCatalog(openApi, invalidDigest), /lowercase sha256/);

  const localReference = structuredClone(invalidDigest);
  localReference.operations.getHealth.promotionEvidence.smoke = {
    digest,
    url: "file:///tmp/smoke.json",
  };
  assert.throws(
    () => validateReadinessCatalog(openApi, localReference),
    /credential-free HTTPS URL/,
  );
});

test("valid immutable staging and acceptance evidence passes", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const candidate = structuredClone(catalog);
  candidate.operations.getHealth = {
    ...candidate.operations.getHealth,
    promotionEvidence: promotionEvidence(),
    state: "staging-ready",
  };
  candidate.operations.getReadiness = {
    ...candidate.operations.getReadiness,
    promotionEvidence: promotionEvidence(),
    state: "accepted",
  };

  assert.doesNotThrow(() => validateReadinessCatalog(openApi, candidate));
});

test("promotion verification fetches and authenticates every required artifact", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const candidate = structuredClone(catalog);
  const { bodies, references } = fetchedEvidence("getHealth");
  candidate.operations.getHealth = {
    ...candidate.operations.getHealth,
    promotionEvidence: references,
    state: "accepted",
  };
  const requests = [];

  await verifyPromotionEvidence(openApi, candidate, {
    environment: {
      MELTIPLY_READINESS_EVIDENCE_AUTHORIZATION: "Bearer test-token",
      MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN: "https://ci.example.test",
    },
    fetchImplementation: async (url, init) => {
      requests.push({ init, url });
      return fetchFrom(bodies)(url);
    },
  });

  assert.equal(requests.length, 5);
  for (const { init } of requests) {
    assert.deepEqual(init.headers, { authorization: "Bearer test-token" });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("promotion verification fails when evidence is unavailable or has the wrong digest", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const candidate = structuredClone(catalog);
  const { bodies, references } = fetchedEvidence("getHealth");
  candidate.operations.getHealth = {
    ...candidate.operations.getHealth,
    promotionEvidence: references,
    state: "staging-ready",
  };

  await assert.rejects(
    verifyPromotionEvidence(openApi, candidate, {
      fetchImplementation: async () => {
        throw new Error("network unavailable");
      },
    }),
    /unable to fetch evidence artifact/,
  );

  candidate.operations.getHealth.promotionEvidence.smoke.digest = `sha256:${"b".repeat(64)}`;
  await assert.rejects(
    verifyPromotionEvidence(openApi, candidate, {
      fetchImplementation: fetchFrom(bodies),
    }),
    /evidence artifact digest mismatch/,
  );
});

test("promotion verification rejects oversized evidence before reading it", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const candidate = structuredClone(catalog);
  const { bodies, references } = fetchedEvidence("getHealth");
  candidate.operations.getHealth = {
    ...candidate.operations.getHealth,
    promotionEvidence: references,
    state: "staging-ready",
  };

  await assert.rejects(
    verifyPromotionEvidence(openApi, candidate, {
      fetchImplementation: async (url) =>
        new Response(bodies.get(url), {
          headers: { "content-length": String(1024 * 1024 + 1) },
          status: 200,
        }),
    }),
    /evidence artifact exceeds 1048576 bytes/,
  );
});

test("promotion verification rejects wrong-kind, failing, and operation-incomplete evidence", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const cases = [
    {
      expected: /kind must be conformance/,
      override: { kind: "smoke" },
    },
    {
      expected: /result must be passed/,
      override: { result: "failed" },
    },
    {
      expected: /does not cover operation getHealth/,
      override: { operationIds: ["getReadiness"] },
    },
  ];

  for (const { expected, override } of cases) {
    const candidate = structuredClone(catalog);
    const { bodies, references } = fetchedEvidence("getHealth", {
      conformance: override,
    });
    candidate.operations.getHealth = {
      ...candidate.operations.getHealth,
      promotionEvidence: references,
      state: "staging-ready",
    };
    await assert.rejects(
      verifyPromotionEvidence(openApi, candidate, {
        fetchImplementation: fetchFrom(bodies),
      }),
      expected,
    );
  }
});

test("check mode fails when a promoted artifact cannot be fetched", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  const candidate = structuredClone(catalog);
  candidate.operations.getHealth = {
    ...candidate.operations.getHealth,
    promotionEvidence: promotionEvidence(),
    state: "worker-preview",
  };

  const directory = await mkdtemp(join(tmpdir(), "meltiply-readiness-check-"));
  const metadata = join(directory, "operation-readiness.json");
  const output = join(directory, "endpoint-readiness.md");
  try {
    await Promise.all([
      writeFile(metadata, JSON.stringify(candidate), "utf8"),
      writeFile(output, renderEndpointReadiness(openApi, candidate), "utf8"),
    ]);
    await assert.rejects(
      run(["--check", "--metadata", metadata, "--openapi", openApiPath, "--output", output], {
        fetchImplementation: async () => {
          throw new Error("artifact unavailable");
        },
      }),
      /unable to fetch evidence artifact/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("generator output is deterministic and check mode rejects drift", async () => {
  const { catalog, openApi } = await loadCanonicalInputs();
  assert.equal(
    renderEndpointReadiness(openApi, catalog),
    renderEndpointReadiness(openApi, structuredClone(catalog)),
  );

  const directory = await mkdtemp(join(tmpdir(), "meltiply-readiness-"));
  const output = join(directory, "endpoint-readiness.md");
  try {
    await writeFile(output, renderEndpointReadiness(openApi, catalog), "utf8");
    await assert.doesNotReject(
      run(["--check", "--metadata", metadataPath, "--openapi", openApiPath, "--output", output]),
    );

    await writeFile(output, "stale\n", "utf8");
    await assert.rejects(
      run(["--check", "--metadata", metadataPath, "--openapi", openApiPath, "--output", output]),
      /is stale/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
