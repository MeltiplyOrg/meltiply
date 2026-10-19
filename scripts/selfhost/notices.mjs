import { cpSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertAllowedLicenses,
  cycloneDxBom,
  javascriptCatalog,
  javascriptComponents,
} from "../ci/supply-chain.mjs";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "dist/selfhost/notices");
const policy = JSON.parse(readFileSync(join(root, "scripts/ci/allowed-licenses.json"), "utf8"));
const components = [];

/**
 * Canonical texts for native packages whose prebuilt platform artifacts omit a
 * license file. LGPLv3 incorporates GPLv3 by reference, so both ship together.
 */
const fallbackLicenses = {
  "LGPL-3.0-or-later": ["LGPL-3.0-or-later.txt", "GPL-3.0-or-later.txt"],
};

/** Retains original upstream notices and metadata for every reachable production dependency, never development tool code. */
function onPackage({ manifestPath, metadata, license }) {
  const directory = dirname(manifestPath);
  const destination = join(output, `${encodeURIComponent(metadata.name)}@${metadata.version}`);
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, "package.json"),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        license,
        repository: metadata.repository,
        homepage: metadata.homepage,
      },
      null,
      2,
    ),
  );
  let copiedLicense = false;
  for (const path of globSync(
    [
      "LICENSE*",
      "license*",
      "LICENCE*",
      "licence*",
      "NOTICE*",
      "notice*",
      "COPYING*",
      "AUTHORS*",
      "licenses/**",
      "LICENSES/**",
    ],
    { cwd: directory },
  )) {
    const source = join(directory, path);
    if (!statSync(source).isFile()) continue;
    const target = join(destination, relative(directory, source));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    if (/^(LICENSE|license|LICENCE|licence|COPYING|licenses\/|LICENSES\/)/.test(path)) {
      copiedLicense = true;
    }
  }
  if (!copiedLicense) {
    for (const file of fallbackLicenses[license] ?? []) {
      cpSync(join(root, "LICENSES", file), join(destination, file));
    }
  }
}

for (const project of [root, import.meta.dirname]) {
  const catalog = javascriptCatalog(project, {
    licenseMetadata: policy.licenseMetadata,
    onPackage,
  });
  assertAllowedLicenses(catalog, policy.javascript, "Self-hosted production JavaScript");
  components.push(...javascriptComponents(catalog));
}
mkdirSync(output, { recursive: true });
writeFileSync(
  join(output, "sbom.cdx.json"),
  `${JSON.stringify(cycloneDxBom(components, "selfhost"), null, 2)}\n`,
);
