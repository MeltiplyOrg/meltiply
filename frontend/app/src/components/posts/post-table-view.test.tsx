// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useLayoutEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { I18nProvider, useI18n } from "@/lib/i18n";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Post } from "@/types";
import { PostTableView } from "./post-table-view";
import type { PostRow } from "./types";

afterEach(cleanup);

function InGerman({ children }: { children: React.ReactNode }) {
  const { language, setLanguage } = useI18n();
  useLayoutEffect(() => setLanguage("de"), [setLanguage]);
  return language === "de" ? children : null;
}

const basePost = contractSuccessBody<Post>("getPost");
const row: PostRow = {
  id: basePost.id,
  date: "2026-10-23T12:00:00Z",
  status: "published",
  brandProfileId: basePost.brand_profile_id,
  post: {
    ...basePost,
    status: "active",
    analytics: {
      likes: 0,
      comments: 0,
      shares: 0,
      saves: null,
      clicks: null,
      views: 1234,
      impressions: null,
      reach: null,
    },
  },
  channels: [
    {
      id: "channel",
      postId: basePost.id,
      publishDate: "2026-10-23T12:00:00Z",
      status: "published",
      content: [],
      attachments: [],
    },
  ],
};

describe("PostTableView analytics", () => {
  it("formats metric cells in the active language", () => {
    render(
      <I18nProvider>
        <InGerman>
          <PostTableView
            posts={[row]}
            isLoading={false}
            footer={null}
            sortKey="date-desc"
            brandProfiles={[]}
            groupBy="none"
            hiddenColumns={new Set()}
            onSortChange={vi.fn()}
            onViewDetails={vi.fn()}
            canCreate={false}
            onCreatePost={vi.fn()}
            selectedIds={new Set()}
            onToggleSelection={vi.fn()}
            onSetSelection={vi.fn()}
          />
        </InGerman>
      </I18nProvider>,
    );
    expect(screen.getByText("1.234")).toBeInTheDocument();
  });
});
