import {
  existsSync,
  globSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import parseSpdx from "spdx-expression-parse";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyPath = join(repositoryRoot, "scripts/ci/allowed-licenses.json");
const defaultOutputPath = join(repositoryRoot, "artifacts/sbom.cdx.json");

/**
 * Resolves an installed dependency through Node's search paths, including Bun's
 * isolated workspace symlinks and export-hidden manifests. Missing optional
 * edges are excluded; missing required edges fail instead of shrinking coverage.
 */
function dependencyManifest(parent, name, optional) {
  if (isBuiltin(name)) return undefined;
  const searchPaths = createRequire(parent).resolve.paths(name) ?? [];
  for (const directory of searchPaths) {
    const candidate = join(directory, name, "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  if (optional) return undefined;
  throw new Error(`Missing dependency ${name} required by ${parent}`);
}

/**
 * Reads declared licensing or a reviewed package/version/declaration correction.
 * Missing or non-SPDX metadata is corrected only when the installed upstream
 * license file matches its SHA-256; changed text or versions fail closed.
 */
function packageLicense(pkg, manifestPath, corrections) {
  const declared = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  const correction = corrections.find(
    (entry) =>
      entry.name === pkg.name && entry.version === pkg.version && entry.declared === declared,
  );
  if (!correction) return declared;
  const text = readFileSync(join(dirname(manifestPath), correction.file));
  if (createHash("sha256").update(text).digest("hex") !== correction.sha256) {
    throw new Error(`Reviewed license text changed: ${pkg.name}@${pkg.version}`);
  }
  return correction.license;
}

/**
 * Inventories runtime dependencies of every workspace; includeDevelopment also
 * follows workspace devDependencies, never third-party development dependencies.
 * Optional platform packages may be absent, but required edges and license
 * metadata must exist or match a reviewed, hash-pinned upstream license file.
 * An optional synchronous onPackage visitor receives each resolved third-party
 * manifest and its normalized license for artifact notice generation. It runs
 * only for reachable packages; development-only dependencies remain excluded.
 *
 * `workspaceRoot` defaults to `root`. Pass the repository root when `root` is a
 * single workspace so private workspace packages are skipped as local code
 * instead of being rejected for missing third-party license metadata.
 */
export function javascriptCatalog(
  root = repositoryRoot,
  { includeDevelopment = false, licenseMetadata = [], onPackage, workspaceRoot = root } = {},
) {
  const rootManifest = realpathSync(join(root, "package.json"));
  const workspaceManifest = join(workspaceRoot, "package.json");
  const workspaceMetadata = JSON.parse(readFileSync(workspaceManifest, "utf8"));
  const workspaces = new Set([realpathSync(workspaceManifest), rootManifest]);
  for (const pattern of workspaceMetadata.workspaces ?? []) {
    for (const path of globSync(`${pattern}/package.json`, {
      cwd: workspaceRoot,
      exclude: ["**/node_modules/**"],
    })) {
      workspaces.add(realpathSync(join(workspaceRoot, path)));
    }
  }
  const allProductionDependencies = new Set();
  const allDevDependencies = new Set();
  for (const manifestPath of workspaces) {
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      allProductionDependencies.add(name);
    }
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      allDevDependencies.add(name);
    }
  }
  const visited = new Set();
  const catalog = {};

  /**
   * Visits each installed manifest once. Workspace development edges are included
   * only for the development inventory; optional declarations override required
   * ones, and production excludes optional peers installed only as dev tools.
   */
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (!workspaces.has(path)) {
      const license = packageLicense(pkg, path, licenseMetadata);
      if (!pkg.name || !pkg.version || !license) {
        throw new Error(
          `JavaScript dependencies missing license metadata: ${pkg.name ?? path}@${pkg.version ?? "unknown"}`,
        );
      }
      (catalog[license] ??= []).push({
        name: pkg.name,
        versions: [pkg.version],
      });
      onPackage?.({ manifestPath: path, metadata: pkg, license });
    }
    const optional = pkg.optionalDependencies ?? {};
    const edges = new Map();
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      edges.set(name, Object.hasOwn(optional, name));
    }
    for (const name of Object.keys(optional)) edges.set(name, true);
    if (includeDevelopment && workspaces.has(path)) {
      for (const name of Object.keys(pkg.devDependencies ?? {})) {
        if (!edges.has(name)) edges.set(name, false);
      }
    }
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (!edges.has(name)) {
        const isOptional = pkg.peerDependenciesMeta?.[name]?.optional === true;
        if (
          !includeDevelopment &&
          isOptional &&
          allDevDependencies.has(name) &&
          !allProductionDependencies.has(name)
        ) {
          continue;
        }
        edges.set(name, isOptional);
      }
    }
    for (const [name, isOptional] of edges) {
      const dependency = dependencyManifest(path, name, isOptional);
      if (dependency) visit(dependency);
    }
  }

  const visitRoots =
    resolve(root) === resolve(workspaceRoot) ? workspaces : new Set([rootManifest]);
  for (const path of visitRoots) visit(path);
  return catalog;
}

/**
 * Evaluates parsed SPDX choices without weakening the approved-license policy:
 * OR permits one approved alternative, AND requires both, and WITH exceptions
 * and legacy "+" variants require their own explicitly approved identifiers.
 */
function approvedSpdxNode(node, allowed) {
  if ("conjunction" in node) {
    return node.conjunction === "or"
      ? approvedSpdxNode(node.left, allowed) || approvedSpdxNode(node.right, allowed)
      : approvedSpdxNode(node.left, allowed) && approvedSpdxNode(node.right, allowed);
  }
  const identifier = `${node.license}${node.plus ? "+" : ""}${node.exception ? ` WITH ${node.exception}` : ""}`;
  return allowed.has(identifier);
}

/**
 * Rejects unapproved SPDX expressions and unreviewed custom terms. OR needs one
 * approved alternative; AND needs both. Package/version/license exceptions can
 * approve custom terms only when every affected entry matches, never globally.
 * Call production without exceptions so development approvals cannot leak in.
 */
export function assertAllowedLicenses(catalog, allowed, ecosystem, exceptions = []) {
  const approved = new Set(allowed);
  const rejected = Object.keys(catalog)
    .filter((license) => {
      const packages = catalog[license];
      const reviewed =
        packages.length > 0 &&
        packages.every(
          (pkg) =>
            pkg.versions.length > 0 &&
            pkg.versions.every((version) =>
              exceptions.some(
                (exception) =>
                  exception.name === pkg.name &&
                  exception.version === version &&
                  exception.license === license,
              ),
            ),
        );
      if (reviewed) return false;
      try {
        return !approvedSpdxNode(parseSpdx(license), approved);
      } catch {
        return true;
      }
    })
    .sort();
  if (rejected.length > 0) {
    throw new Error(`${ecosystem} contains unapproved licenses: ${rejected.join(", ")}`);
  }
}

/**
 * Preserves compound SPDX expressions and exceptions in CycloneDX. Reviewed
 * non-SPDX terms and LicenseRef identifiers use license.name, never a false SPDX
 * license.id. The policy gate must approve the catalog before serialization.
 */
function componentLicense(license) {
  if (license.startsWith("LicenseRef-")) return [{ license: { name: license } }];
  try {
    const parsed = parseSpdx(license);
    return parsed.license !== license ? [{ expression: license }] : [{ license: { id: license } }];
  } catch {
    return [{ license: { name: license } }];
  }
}

/**
 * Encodes package name segments for Package URL (purl) generation, correctly escaping scoped npm packages.
 *
 * @param {string} name - Raw npm package name
 * @returns {string} URI-encoded purl name component
 */
function purlName(name) {
  return name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Converts a reachable JavaScript license catalog into an array of CycloneDX component descriptors.
 *
 * @param {Record<string, Array<{ name: string, versions: Array<string> }>>} catalog - Filtered reachable license catalog
 * @returns {Array<object>} List of CycloneDX library component objects with package URLs and licenses
 */
export function javascriptComponents(catalog) {
  const components = [];
  for (const [license, packages] of Object.entries(catalog)) {
    for (const packageEntry of packages) {
      for (const version of packageEntry.versions) {
        const purl = `pkg:npm/${purlName(packageEntry.name)}@${encodeURIComponent(version)}`;
        components.push({
          "bom-ref": purl,
          licenses: componentLicense(license),
          name: packageEntry.name,
          purl,
          type: "library",
          version,
        });
      }
    }
  }
  return components;
}

/**
 * Builds a deterministic CycloneDX 1.6 Software Bill of Materials (SBOM) document.
 * Deduplicates and sorts components alphabetically by bom-ref.
 *
 * @param {Array<object>} components - CycloneDX component objects
 * @param {string} version - Root application version string
 * @returns {object} Full CycloneDX 1.6 SBOM object
 */
export function cycloneDxBom(components, version) {
  const unique = new Map();
  for (const component of components) unique.set(component["bom-ref"], component);
  return {
    bomFormat: "CycloneDX",
    components: [...unique.values()].sort((left, right) =>
      left["bom-ref"].localeCompare(right["bom-ref"]),
    ),
    metadata: {
      component: {
        "bom-ref": `pkg:generic/meltiply@${encodeURIComponent(version)}`,
        name: "meltiply",
        type: "application",
        version,
      },
      tools: {
        components: [
          {
            name: "scripts/ci/supply-chain.mjs",
            type: "application",
            version: "1",
          },
        ],
      },
    },
    specVersion: "1.6",
    version: 1,
  };
}

/**
 * Resolves the destination path for the SBOM artifact from CLI arguments or returns the default path.
 *
 * @param {Array<string>} argv - CLI arguments
 * @returns {string} Absolute output file path
 * @throws {TypeError} If CLI arguments are invalid
 */
function outputPath(argv) {
  if (argv.length === 0) return defaultOutputPath;
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new TypeError("usage: supply-chain.mjs [--output <path>]");
  }
  return resolve(repositoryRoot, argv[1]);
}

/**
 * Validates production licenses without exceptions, then runtime plus workspace
 * development licenses with narrowly reviewed tool approvals. Writes a complete
 * deterministic CycloneDX SBOM with mode 0o600 only after both inventories pass.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)] - Command line options
 * @returns {{ components: number, output: string }} Count of components included and output file path
 * @throws {Error} If dependency license is unapproved or required metadata is missing
 */
export function runSupplyChainGate(argv = process.argv.slice(2)) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const runtimeCatalog = javascriptCatalog(repositoryRoot, {
    licenseMetadata: policy.licenseMetadata,
  });
  assertAllowedLicenses(runtimeCatalog, policy.javascript, "Production JavaScript");
  const fullCatalog = javascriptCatalog(repositoryRoot, {
    includeDevelopment: true,
    licenseMetadata: policy.licenseMetadata,
  });
  assertAllowedLicenses(
    fullCatalog,
    policy.javascript,
    "Development JavaScript",
    policy.developmentExceptions,
  );

  const components = javascriptComponents(fullCatalog);
  const bom = cycloneDxBom(components, packageMetadata.version);
  const destination = outputPath(argv);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(bom, null, 2)}\n`, {
    mode: 0o600,
  });
  return { components: bom.components.length, output: destination };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runSupplyChainGate();
    process.stdout.write(
      `Supply-chain policy passed (${result.components} components); wrote ${result.output}\n`,
    );
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : "supply-chain gate failed"}\n`,
    );
    process.exitCode = 1;
  }
}
