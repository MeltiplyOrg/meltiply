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

function DocsBrand({ className, ...props }: ComponentProps<"a">) {
  return (
    <a {...props} className={["docs-brand", className].filter(Boolean).join(" ")}>
      <BrandMark className="size-6" />
      <span className="font-semibold">Meltiply Docs</span>
    </a>
  );
}

function SiteFooter() {
  return (
    <footer className="docs-footer">
      <span>© {new Date().getFullYear()} Meltiply</span>
      <nav className="docs-footer-links" aria-label="Legal">
        <a href="/docs/terms">Terms</a>
        <a href="/docs/privacy">Privacy</a>
        <a href="/docs/cookies">Cookies</a>
        <a href="/third-party-notices.txt" data-astro-reload>
          Licenses
        </a>
      </nav>
    </footer>
  );
}

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
              <div className="contents" dangerouslySetInnerHTML={{ __html: content }} />
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
