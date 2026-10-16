# turnstile-spin (skill)

End-to-end setup wizard for Cloudflare Turnstile: widget creation, frontend snippets, server-side siteverify, and a real validation pass. Loads when an agent is asked to add Turnstile, set up CAPTCHA, or protect a form from bots.

[`SKILL.md`](./SKILL.md) is the canonical machine-readable behavior; the hosted prompt at [`developers.cloudflare.com/turnstile/spin/prompt.md`](https://developers.cloudflare.com/turnstile/spin/prompt.md) packages the same behavior for agents without this bundle. Product requirements come from the [Turnstile documentation](https://developers.cloudflare.com/turnstile/index.md).

**Sync constraint:** any behavioral change to `SKILL.md` must also be applied to `public/turnstile/spin/prompt.md` in the `cloudflare-docs` repository — wizard, security boundaries, recovery flow, and validation requirements must match.

## Layout

| Path                  | Purpose                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SKILL.md`            | Wizard instructions the agent executes                                                                     |
| `scripts/`            | Deterministic helpers: API token probe, widget creation, dummy-siteverify validation, skill persistence    |
| `references/`         | Frontend insertion snippets per framework (vanilla HTML, Next.js App/Pages Router, Astro, SvelteKit, Hugo) |
| `tests/validation.md` | Validation cases matching the PRD assertions                                                               |

## Installing the bundle

Agents that load skill bundles from `github.com/cloudflare/skills` pick this up automatically. For a local skills directory, clone once and symlink:

```sh
git clone https://github.com/cloudflare/skills ~/.config/cloudflare-skills
ln -s ~/.config/cloudflare-skills/skills/turnstile-spin ~/.claude/skills/turnstile-spin
```

If cloning is not an option, the hosted single-file prompt is a read-only fallback that fetches `scripts/` and `references/` on demand via `fetch_spin_script`; `scripts/persist-skill.sh` requires the cloned bundle and cannot run from a single-file install. See `SKILL.md` Step 11 for other agent targets.

## Related

- [Canonical docs page](https://developers.cloudflare.com/turnstile/spin/index.md)
- [`cloudflare/skills`](https://github.com/cloudflare/skills) — root index for all Cloudflare agent skills
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/index.md) — siteverify reference
