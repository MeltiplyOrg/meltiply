# Licensing and publication

## What the repository license means

Original Meltiply material is source-available under the [Sustainable Use License](../LICENSE.md), not OSI-approved open source. Its terms permit personal/non-commercial and internal business use; they do not grant a right to sell hosted Meltiply.

Third-party material is excluded from that grant and keeps its own terms. Ship [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the applicable [`LICENSES`](../LICENSES) files with source distributions. Do not describe the whole checkout or its dependencies as SUL-only, MIT-only, or cleared for unrestricted commercial redistribution.

## Source publication

Before a public release:

1. Identify the actual copyright owner/licensor. Confirm permission to redistribute employee, contractor, external, and AI-assisted contributions under the repository's license. Git author names and organization membership are not assignments or signed contributor agreements.
2. Keep third-party licenses, attribution, modification notices, and any applicable upstream NOTICE files with copied material. Do not relicense those files under SUL merely by placing them in this repository.
3. Install the locked dependencies and run:

   ```bash
   bun install --frozen-lockfile
   bun run test:supply-chain
   bun run security:supply-chain
   ```

   The last command writes `artifacts/sbom.cdx.json` for the installed runtime and workspace development graph. Optional native packages absent on the current OS/architecture are not inventoried. Repeat on every release target. The inventory records licenses; it does not collect every package's copyright notices or corresponding source.

4. Review the complete release file set for secrets, customer data, artwork rights, and dependency notices. Include only assets with established provenance and permission to redistribute.
5. Review every Git ref and historical object included in a source release, not just the current files. A current dependency inventory does not establish the rights to historical dependencies or assets.

Source-only releases exclude installed dependencies, browser builds, Worker bundles, container images, installed native libraries, and database exports. Original generated media test fixtures are source test data, not redistributed FFmpeg/libvips executables. Built artifacts require the additional review below.

## Development tools

The license policy separately checks production dependencies with **no restricted-tool exceptions**, then the development graph with exact package/version/license approvals. Missing/indirect metadata is accepted only when an exact-version correction matches the SHA-256 of the installed upstream license file. SPDX `OR` permits an approved alternative; `AND` requires every branch; unreviewed expressions and exceptions fail closed.

Agentation 3.0.2 and React Doctor/plugin 0.9.14 remain restricted development tools, not permissively relicensed components. Their exact terms and permitted development scope are in [the notice index](../THIRD_PARTY_NOTICES.md#restricted-tools-are-development-only). Recheck terms before upgrading, moving them into runtime code, selling a competing developer tool, or using React Doctor source/derivatives in AI training/evaluation/improvement pipelines.

## Compiled web and Worker distributions

A source-only checkout does not include installed `node_modules`. A production build, browser-delivered JavaScript, Worker bundle, or archive that includes dependencies does redistribute their code.

For each actual release artifact, preserve the copyright/license notices for the dependencies it contains, including bundled transitive code. Include required Apache notices and changes; provide source for modified MPL-covered files when required. Selecting Apache-2.0 for dual-licensed DOMPurify requires preserving its Apache terms and applicable notices, not simply deleting the MPL label. Keep development-only tools out of production artifacts.

Run `bun run notices` to regenerate the checked-in browser and public-site bundles at `frontend/app/public/third-party-notices.txt` and `frontend/public/public/third-party-notices.txt`. The app HTML declares the bundle with `rel="license"`; the public footer links to it. Each bundle reproduces Meltiply's [Sustainable Use License](../LICENSE.md) first, so the permissive dependency notices cannot be mistaken for a grant to Meltiply material. The generator then reads the installed production graph, embeds shipped license files, includes copied interface code (shadcn, sileo, Lucide/Feather, and the permission-only Gr8r adaptation), and supplies canonical LGPL/GPL text for native `libvips`. Regenerate after every dependency change.

The JavaScript gate is a review aid, not artifact-level clearance. The generated bundles cover npm and copied-interface works; they do not certify native binaries, container base images, or FFmpeg codecs. The SBOM alone is not a notice or source-compliance package.

## Native binaries and container images

The media-processor Dockerfile installs FFmpeg and libvips through Alpine; JavaScript packages can also install native components such as sharp/libvips. These are outside a JavaScript-manifest-only inventory. Publishing a Dockerfile is different from distributing the resulting image.

For every image/binary release:

- Record the exact image digest, OS, architecture, installed package versions, build configuration, and dependencies from the **built artifact**, not just an Alpine release name.
- Preserve copyright and license texts for FFmpeg, libvips, codecs, and their transitive native libraries. Alpine's FFmpeg package can contain GPL- and LGPL-covered code; do not label the whole image LGPL or SUL. The canonical [`LGPL-3.0-or-later`](../LICENSES/LGPL-3.0-or-later.txt) and [`GPL-3.0-or-later`](../LICENSES/GPL-3.0-or-later.txt) texts cover the libvips fallback used by the notice generator; they do not replace the corresponding-source obligation.
- Provide the exact corresponding source, patches, build/install scripts, and any relinking/install information required by the applicable GPL/LGPL versions using a license-compliant distribution method. A package URL, generic upstream checkout, SBOM, or unsupported promise to supply source is not automatically sufficient.
- Keep those third-party rights separate from Meltiply's terms. Review the actual subprocess/linking boundaries; invocation of FFmpeg as a separate executable does not by itself determine every combined-work question.
- Review codec patents and trademark permissions separately from copyright licensing.

Primary references: [Alpine 3.23 FFmpeg package](https://pkgs.alpinelinux.org/package/v3.23/community/x86_64/ffmpeg), [FFmpeg legal guidance](https://ffmpeg.org/legal.html), [libvips license](https://github.com/libvips/libvips/blob/master/COPYING), [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html), and [MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

No native image or binary redistribution package was built or certified in this remediation. Do not publish such artifacts until their exact-version notices and source obligations are satisfied.

## Rights confirmation and future contributions

The repository owner confirmed control of the rights to original Meltiply code and branding, including necessary employer/contractor permissions, and permission to publish under SUL. This is an owner attestation, not an independently verified legal opinion. Third-party material remains under its original terms.

Continue retaining third-party notices and obtaining the required rights for new contributions. An incoming SUL contribution is not automatically a grant to relicense it under other terms; obtain any necessary separate written rights. See [contribution licensing](../CONTRIBUTING.md#licensing).

Source publication does not certify binary/image releases or codec patents. Apply the artifact-specific requirements above when distributing those artifacts.
