import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin, lazyPlugins } from "vite-plus";

// The repo root .env is the single source of truth for frontend public vars:
// dev-backend.sh already sources it for Wrangler, and here its two public
// values feed Vite's import.meta.env. The Cloudflare plugin only loads
// CLOUDFLARE_-prefixed vars from the app directory, so without this define
// the root .env would not reach the app at all.
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
/**
 * Synchronously reads and parses key-value environment pairs from an ini-style `.env` file.
 *
 * Ignores empty lines and comments (`#`).
 *
 * @param filePath Absolute path to the `.env` file on disk.
 * @returns Map of parsed environment keys to trimmed string values.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const parsed: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      parsed[match[1].trim()] = match[2].trim();
    }
  }
  return parsed;
}

/**
 * Vite plugin that watches the repository root `.env` file and restarts the Vite dev server on changes.
 *
 * @returns Vite `Plugin` object configuring server file watch hooks.
 */
function rootEnvReloadPlugin(): Plugin {
  return {
    name: "meltiply-root-env-reload",
    configureServer(server) {
      // Vite only watches .env files inside the project root; restart the dev
      // server when the repo root .env changes so new values apply on save.
      server.watcher.add(rootEnvFile);
      server.watcher.on("change", (changed) => {
        if (changed === rootEnvFile) server.restart();
      });
    },
  };
}

/**
 * Vite plugin redirecting non-canonical host requests (such as raw IP or localhost) to the canonical
 * `FRONTEND_URL` origin (e.g. MagicDNS domain) with a 308 Permanent Redirect for HTML requests.
 *
 * @param frontendUrl Configured public frontend URL origin, if any.
 * @returns Vite `Plugin` object with Connect middleware.
 */
function canonicalFrontendOriginPlugin(frontendUrl: string | undefined): Plugin {
  const canonical = frontendUrl ? new URL(frontendUrl) : undefined;

  return {
    name: "meltiply-canonical-frontend-origin",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestHost = request.headers.host?.toLowerCase();
        const acceptsHtml = request.headers.accept?.includes("text/html");
        if (!canonical || !requestHost || requestHost === canonical.host || !acceptsHtml) {
          next();
          return;
        }

        response.writeHead(308, {
          Location: `${canonical.origin}${request.url ?? "/"}`,
        });
        response.end();
      });
    },
  };
}

/**
 * Vite plugin that stubs the DevBox module out of production builds.
 *
 * `main.tsx` and `providers.tsx` gate the dock behind `isDevMode()`, which is
 * a runtime check — bundlers cannot fold it, so the lazy chunk (and its heavy
 * dev dependencies: react-scan, axe-core, query devtools, agentation) would
 * still be emitted to `dist`. Resolving the module to an empty stub at build
 * time removes the entire subtree from the production artifact while leaving
 * development mode untouched.
 *
 * @returns Vite `Plugin` that no-ops the devbox entry during `vite build`.
 */
function devBoxStubPlugin(): Plugin {
  return {
    name: "devbox-stub",
    apply: "build" as const,
    // The `@/` alias resolves the specifier before `resolveId` hooks run, so
    // match the resolved absolute path in `load` instead.
    load(id: string) {
      const normalized = id.replace(/\\/g, "/").replace(/\.(tsx?|jsx?)$/, "");
      return normalized.endsWith("components/devbox/dev-box")
        ? "export const DevBox = () => null; export const DevBoxClientBridge = () => null;"
        : null;
    },
  };
}

export default defineConfig(() => {
  const rootFileEnv = parseEnvFile(rootEnvFile);
  const publicEnv = Object.fromEntries(
    ["API_BASE_URL"]
      .map((key) => {
        const value = process.env[key]?.trim() || rootFileEnv[key]?.trim();
        return [key, value || undefined];
      })
      .filter(([, value]) => value !== undefined),
  );
  const frontendUrl =
    process.env.FRONTEND_URL?.trim() || rootFileEnv.FRONTEND_URL?.trim() || undefined;
  return {
    // Statically substitute the whitelisted root .env values into import.meta.env.
    // Launcher-provided values override the file so detected MagicDNS origins
    // and configured ports reach browser code.
    define: Object.fromEntries(
      Object.entries(publicEnv).map(([key, value]) => [
        `import.meta.env.${key}`,
        JSON.stringify(value),
      ]),
    ),
    plugins: lazyPlugins(() => [
      react(),
      cloudflare(),
      rootEnvReloadPlugin(),
      canonicalFrontendOriginPlugin(frontendUrl),
      devBoxStubPlugin(),
    ]),
    server: {
      host: process.env.FRONTEND_DEV_HOST ?? "127.0.0.1",
      port: Number(process.env.FRONTEND_DEV_PORT ?? 3000),
      // Vite already permits IP addresses and localhost. Add the configured
      // MagicDNS hostname without opening the server to arbitrary Host headers.
      allowedHosts: frontendUrl ? [new URL(frontendUrl).hostname] : [],
    },
    resolve: {
      // DEV-only Agentation is a React peer dependency. Keep its optimized
      // chunks on the same React singleton as the application and React DOM.
      dedupe: ["react", "react-dom"],
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  };
});
