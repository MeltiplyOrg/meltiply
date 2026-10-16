import assert from "node:assert/strict";
import { test } from "node:test";

import { approvalEvidence, readWorkflowJobs } from "./circleci-approval.mjs";

const workflowId = "11111111-1111-4111-8111-111111111111";
const approvalJobId = "22222222-2222-4222-8222-222222222222";
const approverId = "33333333-3333-4333-8333-333333333333";
const pipelineSha = "a".repeat(40);
const planDigest = "b".repeat(64);

test("reads every workflow jobs page without exposing the token", async () => {
  const requests = [];
  const pages = [
    {
      items: [{ id: "build", name: "build", type: "build", status: "success" }],
      next_page_token: "next-page",
    },
    {
      items: [
        {
          id: approvalJobId,
          name: "staging-foundation-approval",
          type: "approval",
          status: "success",
          approved_by: approverId,
          stopped_at: "2026-07-22T13:00:00Z",
        },
      ],
      next_page_token: null,
    },
  ];
  const jobs = await readWorkflowJobs({
    workflowId,
    token: "protected-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(pages.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(jobs.length, 2);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /page-token=next-page/);
  assert.equal(requests[0].init.headers["Circle-Token"], "protected-token");
  assert.doesNotMatch(JSON.stringify(jobs), /protected-token/);
});

test("emits only verified CircleCI approval identifiers", () => {
  const evidence = approvalEvidence(
    [
      {
        id: approvalJobId,
        name: "staging-foundation-approval",
        type: "approval",
        status: "success",
        approved_by: approverId,
        stopped_at: "2026-07-22T13:00:00Z",
        project_slug: "gh/example/private",
      },
    ],
    workflowId,
    pipelineSha,
    planDigest,
    "staging-foundation-approval",
  );

  assert.deepEqual(evidence, {
    schema_version: 1,
    workflow_id: workflowId,
    pipeline_sha: pipelineSha,
    plan_digest: planDigest,
    approval_job: {
      id: approvalJobId,
      name: "staging-foundation-approval",
      status: "success",
      approved_by: approverId,
    },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /project_slug|private/);
});

test("fails closed for missing, ambiguous, pending, or anonymous approvals", () => {
  assert.throws(
    () => approvalEvidence([], workflowId, pipelineSha, planDigest, "staging-foundation-approval"),
    /expected exactly one/,
  );
  const approved = {
    id: approvalJobId,
    name: "staging-foundation-approval",
    type: "approval",
    status: "success",
    approved_by: approverId,
    stopped_at: "2026-07-22T13:00:00Z",
  };
  assert.throws(
    () =>
      approvalEvidence(
        [approved, { ...approved, id: workflowId }],
        workflowId,
        pipelineSha,
        planDigest,
        approved.name,
      ),
    /found 2/,
  );
  assert.throws(
    () =>
      approvalEvidence(
        [{ ...approved, status: "on_hold" }],
        workflowId,
        pipelineSha,
        planDigest,
        approved.name,
      ),
    /status must be success/,
  );
  assert.throws(
    () =>
      approvalEvidence(
        [{ ...approved, approved_by: null }],
        workflowId,
        pipelineSha,
        planDigest,
        approved.name,
      ),
    /no valid approved_by ID/,
  );
  assert.throws(
    () =>
      approvalEvidence(
        [{ ...approved, stopped_at: "not-a-time" }],
        workflowId,
        pipelineSha,
        planDigest,
        approved.name,
      ),
    /no valid completion time/,
  );
  assert.throws(
    () => approvalEvidence([approved], "not-a-uuid", pipelineSha, planDigest, approved.name),
    /workflow ID must be a UUID/,
  );
  assert.throws(
    () => approvalEvidence([approved], workflowId, "short", planDigest, approved.name),
    /pipeline SHA must contain exactly 40 hex characters/,
  );
  assert.throws(
    () => approvalEvidence([approved], workflowId, pipelineSha, planDigest, "other-hold"),
    /not an allowed staging hold/,
  );
  assert.throws(
    () => approvalEvidence([approved], workflowId, pipelineSha, "A".repeat(64), approved.name),
    /plan digest must contain exactly 64 lowercase hex characters/,
  );
});

test("rejects malformed identifiers and repeated pagination tokens", async () => {
  await assert.rejects(
    readWorkflowJobs({
      workflowId: "11111111-1111-1111-1111-11111111111-",
      token: "protected-token",
      fetchImpl: async () => assert.fail("fetch must not run"),
    }),
    /workflow ID must be a UUID/,
  );

  await assert.rejects(
    readWorkflowJobs({
      workflowId,
      token: "protected-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [], next_page_token: "same-page" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    /repeated page token/,
  );

  await assert.rejects(
    readWorkflowJobs({
      workflowId,
      token: "protected-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [], next_page_token: "x".repeat(1025) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    /invalid page token/,
  );
});
