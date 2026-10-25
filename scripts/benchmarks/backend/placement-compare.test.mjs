import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { comparePlacement } from "./placement-compare.mjs";

/** Starts a disposable HTTP upstream with observable requests; closes all sockets after the scenario. */
async function upstream(operation) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      workspace: request.headers["x-workspace-id"],
    });
    operation(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
const input = {
  token: "controlled-benchmark-token",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-10-25T00:00:00.000Z",
  samples: 2,
  location: "loopback transport fixture",
};

test("placement experiment measures paired complete actions and retains routing evidence without private data", async () => {
  const baseline = await upstream((_request, response) => {
    response.writeHead(200, { "cf-placement": "local-ORD" });
    response.end('{"private":"DO NOT RETAIN"}');
  });
  const candidate = await upstream((_request, response) => {
    response.writeHead(200, { "cf-placement": "remote-IAD" });
    response.end('{"private":"DO NOT RETAIN"}');
  });
  try {
    const report = await comparePlacement({
      ...input,
      baseline: baseline.origin,
      candidate: candidate.origin,
    });
    assert.equal(report.placement_observed, true);
    assert.deepEqual(
      report.summaries.map((row) => [row.workflow, row.revision, row.samples]),
      [
        ["posts.page60", "baseline", 2],
        ["posts.page60", "candidate", 2],
        ["analytics.page", "baseline", 2],
        ["analytics.page", "candidate", 2],
      ],
    );
    assert.deepEqual(
      report.observations
        .filter((entry) => entry.workflow === "analytics.page")
        .map((entry) => entry.responses.length),
      [2, 2, 2, 2],
    );
    for (const request of [...baseline.requests, ...candidate.requests]) {
      assert.equal(request.authorization, `Bearer ${input.token}`);
      assert.equal(request.workspace, input.workspaceId);
      if (request.url.includes("analytics")) {
        const url = new URL(request.url, baseline.origin);
        assert.equal(url.searchParams.get("end"), input.end);
        assert.equal(url.searchParams.get("start"), input.start);
      }
    }
    const artifact = JSON.stringify(report);
    assert.ok(!artifact.includes(input.token));
    assert.ok(!artifact.includes("DO NOT RETAIN"));
    assert.ok(artifact.includes("remote-IAD"));
  } finally {
    await Promise.all([baseline.close(), candidate.close()]);
  }
});

test("placement experiment fails a rejected session and does not follow redirects with bearer credentials", async () => {
  let redirectedReads = 0;
  const target = await upstream((_request, response) => {
    redirectedReads += 1;
    response.end("unexpected");
  });
  const rejected = await upstream((_request, response) => {
    response.writeHead(401);
    response.end("Private account details");
  });
  const redirected = await upstream((_request, response) => {
    response.writeHead(302, { location: target.origin });
    response.end();
  });
  try {
    await assert.rejects(
      comparePlacement({ ...input, baseline: target.origin, candidate: rejected.origin }),
      /returned HTTP 401/u,
    );
    const before = redirectedReads;
    await assert.rejects(
      comparePlacement({ ...input, baseline: rejected.origin, candidate: redirected.origin }),
    );
    assert.equal(redirectedReads, before);
    await assert.rejects(
      comparePlacement({
        ...input,
        baseline: "https://user:secret@example.com",
        candidate: target.origin,
      }),
      /HTTPS origin/u,
    );
    await assert.rejects(
      comparePlacement({
        ...input,
        baseline: rejected.origin,
        candidate: target.origin,
        samples: 0,
      }),
      /samples/u,
    );
  } finally {
    await Promise.all([target.close(), rejected.close(), redirected.close()]);
  }
});
