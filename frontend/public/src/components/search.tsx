"use client";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { createPortal } from "react-dom";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { navigate } from "astro:transitions/client";
import { Search } from "lucide-react";
import { useRef } from "react";

/** Opens the canonical docs dialog from a compact homepage search icon. */
function HomeSearchTrigger() {
  const { setOpenSearch } = useSearchContext();
  return (
    <button
      type="button"
      className="docs-pref-button"
      aria-label="Search documentation"
      title="Search documentation"
      aria-haspopup="dialog"
      onClick={() => setOpenSearch(true)}
    >
      <Search className="docs-pref-button-icon" aria-hidden="true" size={16} />
    </button>
  );
}

/**
 * Makes the existing static-index dialog and Ctrl/Meta+K shortcut available on
 * the homepage. Fumadocs owns focus trapping, result keyboard navigation, and
 * heading selection; both public surfaces fetch the same /search.json index.
 */
export function HomeSearch() {
  return (
    <RootProvider
      pathname="/"
      navigate={navigate}
      theme={{ enabled: false }}
      search={{ SearchDialog: DefaultSearchDialog }}
    >
      <HomeSearchTrigger />
    </RootProvider>
  );
}

/**
 * Search dialog backed by the build-time index emitted at /search.json
 * (src/pages/search.json.ts). `staticClient` downloads that prerendered file
 * once, so search works from a purely static deploy with no API backend; the
 * index only contains pages from the public `docs` collection. The opener is
 * restored on dismissal because Fumadocs' context triggers are outside Radix's
 * DialogTrigger tree; disconnected openers after result navigation are ignored.
 */
export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const opener = useRef<HTMLElement | null>(null);
  const { search, setSearch, query } = useDocsSearch({
    client: staticClient({
      from: "/search.json",
      locale,
    }),
  });

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      {createPortal(
        <>
          <SearchDialogOverlay />
          <SearchDialogContent
            onOpenAutoFocus={() => {
              opener.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }}
            onCloseAutoFocus={(event) => {
              if (!opener.current?.isConnected) return;
              event.preventDefault();
              opener.current.focus();
            }}
          >
            <SearchDialogHeader>
              <SearchDialogIcon />
              <SearchDialogInput />
              <SearchDialogClose />
            </SearchDialogHeader>
            <SearchDialogList items={query.data !== "empty" ? query.data : null} />
          </SearchDialogContent>
        </>,
        document.body,
      )}
    </SearchDialog>
  );
}
