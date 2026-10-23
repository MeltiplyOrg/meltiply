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

function canonicalMiddleware(frontendUrl: string): Middleware {
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
  configureServer.call(
    {} as never,
    {
      middlewares: { use: (handler: Middleware) => (middleware = handler) },
    } as never,
  );
  if (!middleware) throw new Error("canonical frontend origin middleware is unavailable");
  return middleware;
}

afterEach(() => vi.unstubAllEnvs());

describe("Vite frontend configuration", () => {
  it("deduplicates React modules for DEV-only tools", () => {
    const config = viteConfig({ command: "serve", mode: "test" });

    expect(config.resolve?.dedupe).toEqual(["react", "react-dom"]);
  });

  it("redirects alternate HTML navigations without redirecting canonical or asset requests", () => {
    const middleware = canonicalMiddleware("http://dashboard.example.test:3000");
    const response = { end: vi.fn(), writeHead: vi.fn() };
    const next = vi.fn();

    middleware(
      { headers: { accept: "text/html", host: "100.64.0.1:3000" }, url: "/dashboard?tab=activity" },
      response,
      next,
    );
    expect(response.writeHead).toHaveBeenCalledWith(308, {
      Location: "http://dashboard.example.test:3000/dashboard?tab=activity",
    });
    expect(response.end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();

    middleware(
      { headers: { accept: "text/html", host: "dashboard.example.test:3000" }, url: "/dashboard" },
      response,
      next,
    );
    middleware(
      {
        headers: { accept: "application/javascript", host: "100.64.0.1:3000" },
        url: "/src/main.tsx",
      },
      response,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
  });
});
