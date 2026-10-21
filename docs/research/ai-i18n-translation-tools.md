# AI-assisted i18n translation tooling

Research notes, 2026-10-19. Every claim below was read from the linked primary
source (vendor docs, repo, npm); vendor-published quality numbers are repeated as
claims, not independently verified.

## Current setup

- The catalog is hand-written TypeScript: `spanishTranslations` and
  `statusTranslations` in
  [`frontend/app/src/lib/i18n.tsx`](../../frontend/app/src/lib/i18n.tsx).
  English source strings are the keys; Spanish is the only target.
- `translate()` falls back to the source string, so a missing entry ships
  English silently.
- [`i18n.catalog.test.ts`](../../frontend/app/src/lib/i18n.catalog.test.ts)
  already scans TS/TSX with `oxc-parser` for `t("...")`/`translate("es", "...")`
  literals, `aria-label`/`placeholder`/`title`/`alt` attributes, and JSX text,
  and fails on anything not in the catalog. It also pins an intentional-identical
  list (platform names, `#viral #shorts`, `ID: {id}`) and an allowlist of dynamic
  callsites.
- Placeholders are `{name}`-style; the dev-only pseudo-locale
  ([`pseudo-locale.ts`](../../frontend/app/src/lib/pseudo-locale.ts)) expands
  strings for layout checks.
- The gap is: nothing translates the delta, nothing checks placeholder parity
  between English and Spanish, and nothing protects reviewed Spanish text from
  being overwritten.

## What the tooling must handle

1. Find keys used in TS/TSX (already solved in-repo by the catalog test).
2. Translate only missing/changed keys; leave reviewed entries untouched.
3. Preserve `{placeholder}` tokens; fail CI when one is dropped or renamed.
4. Keep product/platform names identical (the existing intentional-identical
   list is exactly this).
5. Run locally and in CI with a bring-your-own model key; this is a self-hosted
   product, so shipping source strings to a SaaS is a decision, not a default.
6. Hold a style line: the catalog is informal `tú` ("Selecciona",
   "inténtalo"), European/neutral Spanish.

## Shortlist: code-first CLIs and actions

| Tool                                                             | AI translation                                                                                     | Bring your own model                                                                      | Formats                                                                               | CI / PR                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Shipi18n](https://github.com/Shipi18n/shipi18n) `@shipi18n/cli` | `translate` (structure-preserving, incremental); `check --semantic` LLM judge                      | Yes: Anthropic/OpenAI SDK peer deps, any key you export; nothing sent to Shipi18n servers | JSON, YAML, ARB, `.xcstrings`, Android `strings.xml`, PO, XLIFF — **not** TS catalogs | GitHub Action, sarif/JUnit, exit codes, pre-commit, Docker, Vite plugin |
| [Lingo.dev](https://lingo.dev/en/docs/cli) `@lingo.dev/cli`      | Hosted localization engines (400+ models, fallbacks, brand voice, rules, glossaries, AI reviewers) | No on Sandbox/Production; BYOK only on Enterprise                                         | 18 formats incl. JSON, YAML, Markdown/MDX, PO, XLIFF, ARB, Android/Xcode strings      | GitHub App opens PRs with no runner; CLI works in any CI                |
| [i18next-cli](https://github.com/i18next/i18next-cli)            | Only through [Locize](https://www.locize.com/ai) (`localize` command, agent skill)                 | Via Locize BYOK                                                                           | i18next JSON                                                                          | `extract`, `status`, `lint` are CI-ready                                |

Key facts:

- Shipi18n is Apache-2.0, no account, no server; `check` is deterministic and
  keyless, `--semantic` is advisory, `lock` records human-blessed translations,
  and `@shipi18n/mcp` exposes the validators to coding agents. It caught real
  dropped-placeholder bugs in public repos (README tally). Its `check` is the
  only tool here that validates placeholder/plural parity for free.
- Lingo.dev's current CLI is a client for the hosted engine: `lingo push` /
  `lingo pull` with a lockfile, delta-only translation, and per-key preservation
  of manual edits; the legacy "call an LLM from your machine" flow is gone.
  Pricing: $0 sandbox plus $2/MTok infrastructure and pass-through LLM cost;
  $99/mo Production; BYOK, data residency, and SSO are Enterprise-only; data
  retention is 7 days (Sandbox) / 30 days (Production).
- i18next-cli's `localize` command plus its shipped `i18next-localization`
  skill and AGENTS.md note is a good pattern to copy for agent workflows, but
  the AI translation step runs on Locize.

## Shortlist: translation platforms with AI

| Platform                                                                    | AI translation                                                                                                                                                          | BYO LLM / self-host                                                                                                                                                                                                                                                                                                              | Agent / CI                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Tolgee](https://docs.tolgee.io/platform/translation_process/ai_translator) | AI Translator with screenshots, key/project descriptions, language notes, TM, Tolgee Context                                                                            | [LLM providers](https://docs.tolgee.io/platform/projects_and_organizations/llm-providers) configurable server-side: OpenAI, Azure OpenAI, Anthropic, Google AI, any OpenAI-compatible endpoint (e.g. LM Studio). Self-hosted: [Apache-2.0](https://github.com/tolgee/tolgee-platform/blob/main/LICENSE) except `ee/` (Tolgee EL) | [MCP server built into the platform](https://docs.tolgee.io/platform/integrations/mcp_server/setup), works on self-hosted; `tolgee-cli` syncs keys/translations                                                            |
| [Weblate](https://docs.weblate.org/en/latest/admin/machine.html)            | Automatic suggestions/auto-translation; [LLM services](https://docs.weblate.org/en/latest/admin/machine.html): OpenAI, Azure OpenAI, Anthropic, Mistral, Ollama (local) | Yes; self-hosted [GPLv3](https://github.com/WeblateOrg/weblate)                                                                                                                                                                                                                                                                  | Git-based sync, GitHub integration, REST API                                                                                                                                                                               |
| [Crowdin](https://support.crowdin.com/crowdin-ai/)                          | Auto-translation, AI suggestions, AI QA; providers incl. OpenAI, Gemini, Azure OpenAI, Anthropic, DeepSeek, xAI, Cloudflare Workers AI                                  | Own API keys supported (or Crowdin-managed)                                                                                                                                                                                                                                                                                      | [GitHub Action](https://github.com/crowdin/github-action/blob/master/docs/AI.md) uploads, pre-translates with AI, downloads, opens a PR; [agent skills](https://github.com/crowdin/skills) enrich string context from code |
| [SimpleLocalize](https://simplelocalize.io/ai-translations/)                | Context-aware AI translation, batch + per-key actions, automations                                                                                                      | Gemini/Claude/OpenAI, OpenRouter, or any OpenAI-compatible endpoint incl. local Ollama; BYOK pays provider directly                                                                                                                                                                                                              | MCP server, CLI, GitHub App                                                                                                                                                                                                |
| [Locize](https://www.locize.com/ai)                                         | AI + MT with glossary/style guide/TM context, review workflow                                                                                                           | BYOK OpenAI/Gemini/Mistral/DeepL or any OpenAI-compatible endpoint; built by the i18next maintainers                                                                                                                                                                                                                             | [MCP server](https://www.locize.com/docs/integration/mcp) with 28 tools; `i18next-cli locize-sync`                                                                                                                         |
| [Lokalise](https://docs.lokalise.com/en/articles/8011393-ai-translations)   | AI Translations tasks; LLM routing (GPT-5, Claude), glossary/TM/style-guide context, quality scoring                                                                    | No custom models; quota-based                                                                                                                                                                                                                                                                                                    | API-driven tasks                                                                                                                                                                                                           |

Tolgee, Weblate, and the BYOK paths at SimpleLocalize/Locize/Crowdin are the
options that can keep source strings inside infrastructure you control. Weblate
and SimpleLocalize explicitly support a local Ollama endpoint; Tolgee supports
any OpenAI-compatible server URL.

## Agent-native integration

Coding agents are now a first-class consumer:

- MCP servers: Tolgee (built into the platform, self-hosted included), Locize,
  SimpleLocalize, Lingo.dev, Shipi18n (`@shipi18n/mcp`, validation needs no key).
- Agent skills/prompts: [i18next's skill and agent
  note](https://www.i18next.com/how-to/ai-coding-agents),
  [Crowdin's context extraction skills](https://github.com/crowdin/skills),
  `lingo` MCP engine management.
- Pattern that fits this repo best: the agent edits the catalog in the same PR
  that adds UI strings, and a deterministic checker (their existing test, plus
  Shipi18n-style placeholder parity) is the gate. The agent never needs a
  separate translation account for that.

## Cloudflare-native option

The repo already runs on Cloudflare; Workers AI offers a dedicated translation
model, [`@cf/meta/m2m100-1.2b`](https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/)
(translation task, sync or batch, $0.342/M input+output tokens), callable from a
Worker binding or the REST API. Any chat model on Workers AI or through AI
Gateway (with provider keys) can serve the same role for a small
`scripts/i18n` command. This keeps everything inside the existing Cloudflare
account with no new vendor, at the cost of owning the prompt, glossary, and
validation logic.

## License-free options (no fees, permissive or self-hosted)

"License free" splits into two questions: does the tool cost money or require an
account, and what license does it carry. These are the options that are free of
charges and permissively licensed or self-hosted:

| Option                                                                     | License    | Cost                                                                                                                 | Model                                                      | Reads TS catalogs                                                      |
| -------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Shipi18n](https://github.com/Shipi18n/shipi18n) `@shipi18n/cli` 2.16.2    | Apache-2.0 | $0 tooling, no account; only LLM tokens you buy for `translate`/`--semantic`                                         | Anthropic/OpenAI via your key; library accepts any adapter | No — locale files only                                                 |
| [i18n-ai-translate](https://github.com/taahamahdi/i18n-ai-translate) 5.3.0 | GPL-3.0    | $0 tooling; OpenAI/Gemini/Anthropic with your key, or **local Ollama = $0**                                          | chatgpt, gemini, claude, ollama                            | **Yes** — `.ts`/`.js` locale modules, imports/types/comments preserved |
| [cli-localize](https://github.com/yigitkonur/cli-localize)                 | MIT        | $0; you supply the LLM (agent session or local)                                                                      | any (token-batched IBF exchange)                           | No — JSON and other file formats                                       |
| [legacy `lingo.dev` CLI](https://www.npmjs.com/package/lingo.dev) 0.138.10 | Apache-2.0 | $0 tooling; provider keys your own (its deps include OpenAI/Anthropic/Google/Mistral/OpenRouter/**Ollama** adapters) | local or BYO key                                           | unverified against the current published package                       |
| [Weblate](https://github.com/WeblateOrg/weblate) self-hosted               | GPL-3.0    | $0 software, your infrastructure                                                                                     | OpenAI/Azure/Anthropic/Mistral/**Ollama** + MT             | via Git sync of exported files                                         |
| Own `scripts/i18n` command                                                 | your code  | $0 with Ollama; Workers AI is usage-priced                                                                           | any                                                        | yes, by design                                                         |

Notes:

- GPL-3.0 applies to the tool, not to the app it translates; running
  `i18n-ai-translate` as a CLI or GitHub Action does not relicense this
  repository. If GPL tooling is unwelcome as a matter of policy, ship
  Apache-2.0/MIT options only.
- Fully local and free: Ollama plus an Apache-2.0/MIT model (Qwen, Mistral) or
  the MIT-licensed M2M100 model behind Workers AI. No account, no per-token
  bill, nothing leaves the machine.
- Free of cost but not permissive: Weblate is GPL-3.0; Tolgee's self-hosted
  core is Apache-2.0 but advanced features need a paid license key
  ([docs](https://docs.tolgee.io/platform/self_hosting/licensing)) and AI/MT
  usage is plan-metered, so treat Tolgee AI as paid.
- Paid/account-based (skip if "license free" is the hard constraint): Lingo.dev
  engine, Lokalise, Crowdin, Locize, SimpleLocalize plans. Their CLIs accept
  your keys, but the platform itself carries a subscription.
- `i18n-ai-translate` is the only license-free tool here that translates a
  TypeScript catalogue in place, and it has `diff` (only changed keys), `check`,
  `--cache`, `--glossary`, and an official GitHub Action.

## Seeded, cached generation: what is actually deterministic

A seed alone cannot make CI reproducible. Evidence:

- [`i18n-ai-translate`](https://github.com/taahamahdi/i18n-ai-translate/blob/master/src/cli_helpers.ts)
  hardcodes `seed: 69420` for its ChatGPT and Ollama engines and sets no seed
  for Gemini or Claude. Anthropic's Messages API has no seed parameter; OpenAI's
  `seed` is [beta and best-effort](https://developers.openai.com/cookbook/examples/reproducible_outputs_with_the_seed_parameter)
  ("some control", outputs still differ across model updates and can differ
  between runs); Ollama lists
  [reproducible outputs](https://docs.ollama.com/api/openai-compatibility) in
  its OpenAI-compatible API.
- The reliable mechanism is a **content-addressed cache plus committed
  artifacts**. `i18n-ai-translate --cache <path>` is a model-agnostic
  translation memory keyed by source text + language pair + context: strings
  already present are never re-sent to the model, `diff` re-translates only
  added/modified keys, and existing translations are preserved. Shipi18n `lock`
  does the same job for hand-approved strings.

So the deterministic contract should be:

| Requirement                                   | Mechanism                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same input produces the same committed output | Translations and the cache file are committed; generation runs offline, not in CI                                                                                 |
| Reruns cost nothing and change nothing        | Cache hit per string; `translate`/`diff` process only cache misses                                                                                                |
| CI verifies without generating                | `shipi18n check` (keyless, deterministic) + the existing catalog test; optionally assert every source key has a cache or catalog entry                            |
| New English string is translated once         | `i18n-ai-translate diff -b <old en> -a <new en> --cache …`; only the new key reaches the model                                                                    |
| Seed usage                                    | Ollama/ChatGPT path carries seed 69420 already; set `temperature: 0` via the library API for stricter repeatability; treat seeds as an audit aid, not a guarantee |
| Idiomatic/slangy Spanish                      | `--context` (product/audience/tone) + `--glossary` (keep-verbatim names and forced terms), both injected into generation and verification                         |

Practical shape: `i18n:generate` (local, seeded, cache-writing, committed) and
`i18n:check` (CI, no model call). Regeneration of a changed key is the only
operation that hits the network, and it is a reviewable diff.

## Free provider choice (Shipi18n-compatible)

Shipi18n translates through an OpenAI-compatible `--base-url` or a custom
`{ complete }` adapter, so any free OpenAI-compatible endpoint works.

| Provider                | Free allowance                         | Model                                                                                                  | Languages                                                            | Seed                                                       |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Cloudflare Workers AI   | 10,000 Neurons/day                     | [`@cf/qwen/qwen3-30b-a3b-fp8`](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/) | Qwen3: [119 languages/dialects](https://arxiv.org/html/2505.09388v1) | `seed` 1–9,999,999,999 + `temperature` in the model schema |
| Cloudflare Workers AI   | same                                   | [`@cf/meta/m2m100-1.2b`](https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/)             | 100                                                                  | no seed; translation-task model, not chat-completions      |
| Google Gemini free tier | free input/output tokens, rate-limited | `gemini-3.8-flash`                                                                                     | 100+                                                                 | direct API seed (verify the OpenAI-compat path)            |
| Ollama (local)          | $0, no quota                           | [`translategemma:12b`](https://ollama.com/library/translategemma)                                      | 55                                                                   | `seed` + `temperature: 0`                                  |
| Ollama (local)          | $0                                     | `qwen3`                                                                                                | 119                                                                  | `seed` + `temperature: 0`                                  |

Recommendation: **Workers AI + Qwen3-30B-A3B-FP8**. It runs on the Cloudflare
account already in the stack, no new vendor or key, and the model schema exposes
`seed` and `temperature`. Pricing is 4,625 Neurons per M input and 30,475 per M
output; a 1,000-string pass at roughly 20k input / 25k output tokens is about
850 Neurons, against 10,000 free Neurons/day
([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
Gemini's free tier uses content to improve Google products; Workers AI keeps it
in your account; local Ollama keeps it on the machine.

Qwen3 is reasoning-capable; verify the first batch comes back as a clean JSON
array. If thinking text interferes, switch to
`@cf/google/gemma-3-12b-it` or `@cf/meta/llama-3.1-8b-instruct-fp8-fast` — both
are inside the free allowance.

### Wiring it

```bash
# CLI path: incremental, no seed exposed by the CLI
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...   # Workers AI Run permission
npx @shipi18n/cli translate locales/en.json -t es -p openai \
  --base-url "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/v1" \
  --model "@cf/qwen/qwen3-30b-a3b-fp8" \
  --api-key "$CLOUDFLARE_API_TOKEN" -i
npx @shipi18n/cli check ./locales -s en
```

`-i` reuses every key already present in `locales/es.json`, so only new or
missing strings reach the model. Commit `locales/es.json`: that file is the
cache, and CI only runs `check`.

The CLI does not pass `seed` or `temperature`. For a seeded run, call
`translateJSON` from `@shipi18n/core` with a custom adapter — the only provider
surface — and send the direct Workers AI request, which accepts both:

```js
const adapter = {
  name: "workers-ai-qwen3",
  async complete(prompt) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/qwen/qwen3-30b-a3b-fp8`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
        body: JSON.stringify({
          messages: [
            { role: "system", content: STYLE_AND_GLOSSARY },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          seed: 20261019,
          max_tokens: 8192,
        }),
      },
    );
    const { result } = await res.json();
    return result.response.trim();
  },
};

await translateJSON({ content, from: "en", to: "es", provider: adapter, existing });
```

The adapter is also where product context, style ("informal `tú`, neutral
Spanish, idiomatic not literal"), and the keep-verbatim glossary go — the
built-in translation prompt has no glossary/context knobs (verified in
`packages/core/src/translate.js`).

Local fallback with no quota:

```bash
ollama pull translategemma:12b
npx @shipi18n/cli translate locales/en.json -t es -p openai \
  --base-url http://localhost:11434/v1 --model translategemma:12b -i
```

## Recommendation for this repo

**Recommended (license-free): Shipi18n + Cloudflare Workers AI Qwen3.**

1. Extract the catalog into `locales/en.json` (English keys, values equal to
   the source strings) and `locales/es.json` (the existing
   `spanishTranslations` map). Runtime behavior is unchanged; `translate()`
   still falls back to English.
2. Gate CI with `npx @shipi18n/cli check ./locales -s en`. It is deterministic,
   keyless, and catches dropped/renamed placeholders, collapsed plurals,
   untranslated values, and missing keys. `lock` records human-approved strings
   so regeneration cannot silently change them.
3. Generate only when English changes, never in CI:
   - fast path: `shipi18n translate locales/en.json -t es -p openai
     --base-url <Workers AI compat URL> --model @cf/qwen/qwen3-30b-a3b-fp8
     --api-key "$CLOUDFLARE_API_TOKEN" -i` (incremental; reuses every key
     already in `es.json`);
   - seeded path: the custom `translateJSON` adapter shown above with
     `temperature: 0` and a fixed `seed`, plus a system prompt carrying style
     and glossary;
   - commit `locales/es.json`. Every new locale repeats this with
     `-t es,fr,de`; Qwen3 covers 119 languages.
4. CI runs step 2 only. A new English key with no Spanish entry fails the
   `untranslated`/missing-key rules, so the gate enforces that generation was
   run and committed — without ever calling a model.

Cost: 10,000 free Neurons/day on Workers AI (≈850 Neurons per 1,000-string
pass at the estimate above), so initial generation plus several locales fits
the free allowance; $0 otherwise until you exceed it. No new vendor.

**Fallback if GPL tooling is acceptable:** [i18n-ai-translate](https://github.com/taahamahdi/i18n-ai-translate)
translates the TS module in place with a committed `--cache`, then still run
`shipi18n check` over the exported JSON. That avoids the JSON extraction step
but adds a second translation pipeline; keep one, not both.

**Alternative: Lingo.dev engine (paid).** Best when you want
glossaries/rules/quality scoring and PR automation with near-zero repo code
(GitHub App opens translation PRs). Source strings go to a hosted engine, BYOK
needs Enterprise, the free Sandbox caps at 100K tokens/day. See
[ci-cd workflows](https://lingo.dev/en/docs/workflows/github).

**Alternative: self-hosted Weblate (free software, no license fee).** Choose
when a review UI for translators matters; Ollama translation in
infrastructure you control. GPL-3.0, heavier operations (Python/Django).
Tolgee is the friendlier platform but its advanced features and AI/MT usage are
metered or licensed, so it is not a "license free" pick.

**Do not do:** adopt a runtime i18n framework just to get AI translation.
Extraction already works here; the missing pieces are delta translation and
placeholder validation.

### Gaps to close whatever you pick

1. Placeholder parity test (English ↔ Spanish) — cheapest now, useful forever.
2. Keep-list enforcement for platform/product names beyond the current
   intentional-identical set.
3. Style instruction: informal `tú`, European/neutral Spanish, no sentence
   lengthening that breaks compact UI.
4. Delta-only translation so reviewed strings are never rewritten by a rerun.
5. Keep machine translation out of CI blocking checks unless the tool is
   deterministic; `--semantic`-style judging belongs in review, not the gate.
