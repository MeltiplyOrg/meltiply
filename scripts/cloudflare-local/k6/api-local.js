import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const baseUrl = (__ENV.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const authToken = (__ENV.K6_AUTH_TOKEN || "").trim();
const vus = Number(__ENV.MELTIPLY_K6_VUS || "5");
const duration = __ENV.MELTIPLY_K6_DURATION || "30s";

const checkFailures = new Rate("meltiply_check_failures");
const healthDuration = new Trend("meltiply_health_duration", true);
const readyDuration = new Trend("meltiply_ready_duration", true);
const usersMeDuration = new Trend("meltiply_users_me_duration", true);

const expect200 = http.expectedStatuses(200);
const expect401 = http.expectedStatuses(401);
const expect200or500 = http.expectedStatuses(200, 500);

export const options = {
  scenarios: {
    public_api: {
      duration,
      executor: "constant-vus",
      gracefulStop: "5s",
      vus: Number.isFinite(vus) && vus > 0 ? vus : 5,
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    meltiply_check_failures: ["rate<0.01"],
    "http_req_duration{name:health}": ["p(95)<500", "p(99)<1500"],
    "http_req_duration{name:ready}": ["p(95)<1000", "p(99)<2500"],
    "http_req_duration{name:users_me_unauth}": ["p(95)<1000", "p(99)<2500"],
    meltiply_health_duration: ["p(95)<500"],
    meltiply_ready_duration: ["p(95)<1000"],
    http_req_failed: ["rate<0.05"],
  },
};

function tagged(name, params = {}) {
  return {
    ...params,
    tags: { ...(params.tags || {}), name },
  };
}

export default function apiLocalScenario() {
  group("public liveness", () => {
    const health = http.get(
      `${baseUrl}/api/v1/health`,
      tagged("health", {
        responseCallback: expect200,
        timeout: "3s",
      }),
    );
    healthDuration.add(health.timings.duration);
    const healthOk = check(health, {
      "health status 200": (response) => response.status === 200,
      "health body ok": (response) => {
        try {
          return JSON.parse(response.body).status === "ok";
        } catch {
          return false;
        }
      },
    });
    checkFailures.add(!healthOk);

    const ready = http.get(
      `${baseUrl}/api/v1/ready`,
      tagged("ready", {
        responseCallback: expect200,
        timeout: "4s",
      }),
    );
    readyDuration.add(ready.timings.duration);
    const readyOk = check(ready, {
      "ready status 200": (response) => response.status === 200,
      "ready body ready": (response) => {
        try {
          return JSON.parse(response.body).status === "ready";
        } catch {
          return false;
        }
      },
    });
    checkFailures.add(!readyOk);
  });

  group("auth boundary", () => {
    const unauth = http.get(
      `${baseUrl}/api/v1/users/me`,
      tagged("users_me_unauth", {
        responseCallback: expect401,
        timeout: "3s",
      }),
    );
    usersMeDuration.add(unauth.timings.duration);
    const unauthOk = check(unauth, {
      "users/me unauth is 401": (response) => response.status === 401,
      "users/me unauth code": (response) => {
        try {
          return JSON.parse(response.body).error?.code === "authentication_required";
        } catch {
          return false;
        }
      },
    });
    checkFailures.add(!unauthOk);

    if (authToken) {
      const authed = http.get(
        `${baseUrl}/api/v1/users/me`,
        tagged("users_me_auth", {
          headers: { Authorization: `Bearer ${authToken}` },
          responseCallback: expect200or500,
          timeout: "4s",
        }),
      );
      usersMeDuration.add(authed.timings.duration);
      const authedOk = check(authed, {
        "users/me auth responded": (response) => response.status === 200 || response.status === 500,
      });
      checkFailures.add(!authedOk);
    }
  });

  sleep(0.25);
}

export function handleSummary(data) {
  const summary = {
    checks_failed: data.metrics.checks?.values.fails ?? 0,
    checks_rate: data.metrics.checks?.values.rate ?? null,
    health_p95: data.metrics["http_req_duration{name:health}"]?.values["p(95)"] ?? null,
    http_req_failed_rate: data.metrics.http_req_failed?.values.rate ?? null,
    http_reqs: data.metrics.http_reqs?.values.count ?? 0,
    iterations: data.metrics.iterations?.values.count ?? 0,
    ready_p95: data.metrics["http_req_duration{name:ready}"]?.values["p(95)"] ?? null,
  };
  return {
    stdout: `${JSON.stringify({ meltiply_k6_summary: summary }, null, 2)}\n`,
  };
}
