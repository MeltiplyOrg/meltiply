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
} from "fumadocs-ui/components/dialog/search";
import type { SharedProps } from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { createPortal } from "react-dom";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { navigate } from "astro:transitions/client";
import { Search } from "lucide-react";
import { useRef } from "react";

export function DocumentationSearchTrigger() {
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

export function HomeSearch() {
  return (
    <RootProvider
      pathname="/"
      navigate={navigate}
      theme={{ enabled: false }}
      search={{ SearchDialog: DefaultSearchDialog }}
    >
      <DocumentationSearchTrigger />
    </RootProvider>
  );
}

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
      {typeof document !== "undefined" &&
        createPortal(
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
