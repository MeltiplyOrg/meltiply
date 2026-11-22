import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin, lazyPlugins } from "vite-plus";
import { renderThemeBootstrap, themeBootstrapMarker } from "../shared/theme-bootstrap-source";
import { previewContractPlugin } from "./preview-contract";

const environmentAssignmentPattern = /^([^#=]+)=(.*)$/;
const sourceExtensionPattern = /\.(tsx?|jsx?)$/;

// @cloudflare/vite-plugin only loads CLOUDFLARE_-prefixed vars from the app directory.
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
const sharedUiManifest = fileURLToPath(new URL("../shared/package.json", import.meta.url));
const themeBootstrapRuntimeFile = fileURLToPath(
  new URL("../shared/theme-bootstrap.js", import.meta.url),
);
const srcRoot = fileURLToPath(new URL("./src", import.meta.url)).replaceAll("\\", "/");
function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const parsed: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = line.match(environmentAssignmentPattern);
    if (match) {
      parsed[match[1].trim()] = match[2].trim();
    }
  }
  return parsed;
}

function rootEnvReloadPlugin(): Plugin {
  return {
    name: "meltiply-root-env-reload",
    configureServer(server) {
      // Workspace export maps are cached by the resolver. Watch the owning
      // manifest as well as root environment values so live edits cannot leave
      // newly exported fonts or controls unresolved until a manual restart.
      server.watcher.add([rootEnvFile, sharedUiManifest]);
      server.watcher.on("change", (changed) => {
        if (changed === rootEnvFile || changed === sharedUiManifest) void server.restart();
      });
    },
  };
}

function canonicalFrontendOriginPlugin(canonical: URL | undefined): Plugin {
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

        const candidate = new URL(request.url ?? "/", canonical.origin);
        const location =
          candidate.origin === canonical.origin ? candidate.href : `${canonical.origin}/`;
        response.writeHead(308, { Location: location });
        response.end();
      });
    },
  };
}

const devOnlyStubModules = new Map<string, string>([
  [
    `${srcRoot}/components/devbox/dev-box`,
    "export const DevBox = () => null; export const DevBoxClientBridge = () => null;",
  ],
  [`${srcRoot}/lib/dev-sign-in`, 'export const localDevOwnerSignIn = { email: "", password: "" };'],
  [
    `${srcRoot}/lib/pseudo-locale`,
    'export const pseudoLocaleEvent = "meltiply:pseudo-locale"; export const isPseudoLocalized = () => false; export const setPseudoLocalization = () => undefined; export const pseudoLocalize = (message) => message;',
  ],
]);

function devOnlyStubPlugin(uiPreview: boolean, building: boolean): Plugin {
  return {
    name: "dev-only-stub",
    enforce: "pre",
    resolveId(id) {
      const normalized = id.replaceAll("\\", "/").replace(sourceExtensionPattern, "");
      if (
        !uiPreview &&
        (normalized.endsWith("/preview/browser") || normalized.endsWith("/preview/controls"))
      )
        return `\0${normalized}`;
    },
    load(id: string) {
      const normalized = id.replaceAll("\\", "/").replace(sourceExtensionPattern, "");
      if (!uiPreview && normalized.endsWith("/preview/browser")) {
        return "export const startPreview = async () => {};";
      }
      if (!uiPreview && normalized.endsWith("/preview/controls")) {
        return "export const PreviewControls = () => null;";
      }
      if (!building) return null;
      if (uiPreview && normalized !== `${srcRoot}/lib/dev-sign-in`) return null;
      return devOnlyStubModules.get(normalized) ?? null;
    },
  };
}

function themeBootstrapPlugin(): Plugin {
  return {
    name: "meltiply-theme-bootstrap",
    transformIndexHtml(html) {
      if (!html.includes(themeBootstrapMarker)) return html;
      const runtime = readFileSync(themeBootstrapRuntimeFile, "utf8");
      return html.replace(
        themeBootstrapMarker,
        `<script>${renderThemeBootstrap(runtime)}</script>`,
      );
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const uiPreview = mode === "ui-preview";
  const rootFileEnv = uiPreview ? {} : parseEnvFile(rootEnvFile);
  const frontendUrl = uiPreview
    ? undefined
    : process.env.APP_URL?.trim() || rootFileEnv.APP_URL?.trim() || undefined;
  const canonical = frontendUrl ? new URL(frontendUrl) : undefined;
  const rawLocalApiPort = process.env.WRANGLER_DEV_PORT || rootFileEnv.WRANGLER_DEV_PORT || "8787";
  const localApiPort = Number(rawLocalApiPort);
  if (!Number.isInteger(localApiPort) || localApiPort < 1 || localApiPort > 65535) {
    throw new Error(`Invalid WRANGLER_DEV_PORT: ${rawLocalApiPort}`);
  }
  const localApp =
    canonical !== undefined && ["localhost", "127.0.0.1", "[::1]"].includes(canonical.hostname);
  return {
    define: uiPreview
      ? { "import.meta.env.APP_URL": JSON.stringify("") }
      : frontendUrl
        ? { "import.meta.env.APP_URL": JSON.stringify(frontendUrl) }
        : {},
    build: uiPreview ? { outDir: "dist/ui-preview" } : {},
    plugins: lazyPlugins(() => [
      react(),
      uiPreview && previewContractPlugin(),
      !uiPreview &&
        cloudflare({
          viteEnvironment: { name: "frontend" },
          config: (config) =>
            localApp
              ? {
                  vars: {
                    ...config.vars,
                    API_ORIGIN: `http://127.0.0.1:${localApiPort}`,
                  },
                }
              : {},
        }),
      rootEnvReloadPlugin(),
      canonicalFrontendOriginPlugin(canonical),
      themeBootstrapPlugin(),
      devOnlyStubPlugin(uiPreview, command === "build"),
    ]),
    server: {
      host: process.env.FRONTEND_DEV_HOST ?? "127.0.0.1",
      port: Number(process.env.FRONTEND_DEV_PORT ?? 3000),
      allowedHosts: canonical ? [canonical.hostname] : [],
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
