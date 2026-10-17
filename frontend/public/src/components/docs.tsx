import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsPage, type DocsPageProps } from "fumadocs-ui/layouts/docs/page";
import type { Root } from "fumadocs-core/page-tree";
import type { ComponentProps } from "react";
import { RootProvider } from "fumadocs-ui/provider/astro";
import type { AstroProviderProps } from "fumadocs-core/framework/astro";
import { BrandMark } from "@meltiply/ui/brand-mark";
import SearchDialog from "./search";
import { DocsPreferences } from "./docs-preferences";
import { DocsThemeProvider } from "./docs-theme";
import { DocsTocTransition } from "./docs-toc-transition";
import { DocsArticleTransition } from "./docs-article-transition";
import { docsRailTocSlots } from "./docs-rail-toc";
import { CookieNotice } from "@meltiply/ui/cookie-notice";
import { Toaster } from "@meltiply/ui/sileo";
import { DocsNavGlide, DocsPathnameContext, NavItem, NavSection } from "./docs-navigation";
import { navigate } from "astro:transitions/client";

/**
 * The shared Meltiply artwork and a single "Meltiply Docs" label identify the
 * sidebar and mobile page header consistently. One inline SVG inherits the
 * ink palette via `currentColor` (the accent diamond resolves through
 * `motion.css`'s `[data-brand-accent]` fill), so light and dark need no swapped
 * assets; `size-6` is the mobile-header size while the sidebar/drawer rules
 * widen `[data-brand-mark]` to the original 28px. Decorative artwork leaves
 * the label as the accessible link name and anchor props remain
 * Fumadocs-owned.
 */
function DocsBrand({ className, ...props }: ComponentProps<"a">) {
  return (
    <a {...props} className={["docs-brand", className].filter(Boolean).join(" ")}>
      <BrandMark className="size-6" />
      <span className="font-semibold">Meltiply Docs</span>
    </a>
  );
}

/**
 * Compact site footer rendered inside the `DocsPage` footer slot (after the
 * previous/next pagination, within the centered article column). Keeps the
 * copyright and legal links together without reopening saved consent choices.
 * Plain-text notices bypass routing; the initial consent prompt belongs to the
 * persistent shell, not to this replaceable article footer.
 */
function SiteFooter() {
  return (
    <footer className="docs-footer">
      <span>© {new Date().getFullYear()} Meltiply</span>
      <nav className="docs-footer-links" aria-label="Legal">
        <a href="/docs/terms">Terms</a>
        <a href="/docs/privacy">Privacy</a>
        <a href="/docs/cookies">Cookies</a>
        <a href="/third-party-notices.txt" data-astro-reload>
          Third-party notices
        </a>
      </nav>
    </footer>
  );
}

/**
 * Persistent sidebar around replaceable, build-time article HTML. Astro swaps
 * pathname, metadata, TOC and content while navigation and preferences stay
 * mounted. Theme controls live in the sidebar; the single
 * shell-owned `CookieNotice` and app-style `Toaster` stay outside the keyed page
 * so route updates retain consent drafts, confirmation deadlines, and copy feedback.
 * Saved consent leaves no shell or article control for reopening preferences.
 * `DocsThemeProvider` owns the shared public-site reveal and OS palette updates;
 * the home link stays same-origin while `appUrl` targets the separate app.
 * Both TOC surfaces share the reading-progress rail;
 * the desktop controller animates it while Fumadocs retains anchor tracking,
 * reading layout, search, and pagination. The theme hotkey stays disabled; toolbar
 * activations anchor the reveal. Article text morphs into streaming line
 * placeholders while navigation loads; incoming heading sections fade upward
 * without delaying initial rendering.
 */
import DOMPurify from "dompurify";

export function Docs({
  tree,
  content,
  pathname,
  params,
  page,
  appUrl = "https://app.meltiply.com",
}: {
  tree: Root;
  content: string;
  pathname: string;
  params: AstroProviderProps["params"];
  page?: DocsPageProps;
  appUrl?: string;
}) {
  return (
    <DocsPathnameContext value={pathname}>
      <RootProvider
        pathname={pathname}
        params={params}
        navigate={navigate}
        theme={{ enabled: false }}
        search={{ SearchDialog }}
      >
        <DocsThemeProvider>
          <DocsLayout
            tree={tree}
            containerProps={{ className: "docs-shell" }}
            themeSwitch={{ enabled: false }}
            sidebar={{
              components: { Separator: NavSection, Item: NavItem },
              banner: <DocsNavGlide />,
              footer: <DocsPreferences includeSearch />,
            }}
            nav={{
              title: DocsBrand,
              url: "/docs/",
            }}
            links={[
              {
                text: "Meltiply.com",
                url: "/",
              },
              {
                type: "button",
                text: "Open app",
                url: appUrl,
                external: true,
              },
            ]}
          >
            <DocsTocTransition pathname={pathname} />
            <DocsArticleTransition pathname={pathname} />
            <DocsPage
              key={pathname}
              {...page}
              slots={{ ...page?.slots, toc: docsRailTocSlots }}
              footer={{ children: <SiteFooter /> }}
            >
              <div
                className="contents"
                dangerouslySetInnerHTML={{
                  __html: typeof window === "undefined" ? content : DOMPurify.sanitize(content),
                }}
              />
            </DocsPage>
          </DocsLayout>
          <div className="docs-feedback">
            <CookieNotice policyUrl="/docs/cookies" />
            <Toaster />
          </div>
        </DocsThemeProvider>
      </RootProvider>
    </DocsPathnameContext>
  );
}
