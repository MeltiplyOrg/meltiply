import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import viteConfig from "./vite.config";

type Middleware = (
  request: { headers: Record<string, string | undefined>; url?: string },
  response: {
    end: () => void;
    writeHead: (status: number, headers: Record<string, string>) => void;
  },
  next: () => void,
) => void;

async function canonicalMiddleware(frontendUrl: string): Promise<Middleware> {
  vi.stubEnv("APP_URL", frontendUrl);
  const config = viteConfig({ command: "serve", mode: "test" });
  const plugin = config.plugins?.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "name" in candidate &&
      candidate.name === "meltiply-canonical-frontend-origin",
  ) as Plugin | undefined;
  if (!plugin) throw new Error("canonical frontend origin plugin is unavailable");
  let middleware: Middleware | undefined;

  const configureServer =
    typeof plugin.configureServer === "function"
      ? plugin.configureServer
      : plugin.configureServer?.handler;
  if (!configureServer) {
    throw new Error("canonical frontend origin plugin is unavailable");
  }
  await configureServer.call(
    {} as never,
    {
      middlewares: { use: (handler: Middleware) => (middleware = handler) },
    } as never,
  );
  if (!middleware) throw new Error("canonical frontend origin middleware is unavailable");
  return middleware;
}

function invoke(
  middleware: Middleware,
  request: { headers: Record<string, string | undefined>; url?: string },
) {
  let ended = false;
  let nextCalled = false;
  let head: { headers: Record<string, string>; status: number } | undefined;
  middleware(
    request,
    {
      end: () => {
        ended = true;
      },
      writeHead: (status, headers) => {
        head = { headers, status };
      },
    },
    () => {
      nextCalled = true;
    },
  );
  return { ended, head, nextCalled };
}

afterEach(() => vi.unstubAllEnvs());

describe("canonical frontend origin middleware", () => {
  it("308: redirects alternate-host HTML navigation to the canonical origin", async () => {
    const middleware = await canonicalMiddleware("http://dashboard.example.test:3000");

    expect(
      invoke(middleware, {
        headers: { accept: "text/html", host: "100.64.0.1:3000" },
        url: "/dashboard?tab=activity",
      }),
    ).toEqual({
      ended: true,
      head: {
        headers: { Location: "http://dashboard.example.test:3000/dashboard?tab=activity" },
        status: 308,
      },
      nextCalled: false,
    });
  });

  it("308: neutralizes a protocol-relative path to root", async () => {
    const middleware = await canonicalMiddleware("http://dashboard.example.test:3000");

    expect(
      invoke(middleware, {
        headers: { accept: "text/html", host: "100.64.0.1:3000" },
        url: "//evil.test/phish",
      }),
    ).toEqual({
      ended: true,
      head: {
        headers: { Location: "http://dashboard.example.test:3000/" },
        status: 308,
      },
      nextCalled: false,
    });
  });

  it("passes through requests already on the canonical host", async () => {
    const middleware = await canonicalMiddleware("http://dashboard.example.test:3000");

    expect(
      invoke(middleware, {
        headers: { accept: "text/html", host: "dashboard.example.test:3000" },
        url: "/dashboard",
      }),
    ).toEqual({ ended: false, head: undefined, nextCalled: true });
  });

  it("passes through non-HTML asset requests on an alternate host", async () => {
    const middleware = await canonicalMiddleware("http://dashboard.example.test:3000");

    expect(
      invoke(middleware, {
        headers: { accept: "application/javascript", host: "100.64.0.1:3000" },
        url: "/src/main.tsx",
      }),
    ).toEqual({ ended: false, head: undefined, nextCalled: true });
  });
});
