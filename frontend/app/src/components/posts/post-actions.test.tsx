// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { PostActions } from "./post-actions";

afterEach(cleanup);

describe("PostActions", () => {
  it("keeps editing in the normal interaction tone and reserves danger for deletion", () => {
    render(
      <I18nProvider>
        <PostActions postId="post-1" canMutate canDelete onEdit={() => {}} onDelete={() => {}} />
      </I18nProvider>,
    );

    const edit = screen.getByRole("button", { name: "Edit post" });
    const remove = screen.getByRole("button", { name: "Delete post" });

    expect(edit).not.toHaveClass("text-red");
    expect(remove).toHaveClass("text-red");
  });
});
