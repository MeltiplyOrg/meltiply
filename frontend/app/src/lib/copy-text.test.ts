// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { copyText } from "@meltiply/ui/copy-text";

beforeAll(async () => {
  await copyText("warm", { writeText: async () => undefined }, document);
});

beforeEach(() => {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  it("uses the asynchronous Clipboard API in secure contexts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.mocked(document.execCommand);

    await copyText("feedback", { writeText }, document);

    expect(writeText).toHaveBeenCalledWith("feedback");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a temporary selection when Clipboard API is unavailable", async () => {
    const execCommand = vi.mocked(document.execCommand).mockReturnValue(true);

    await copyText("tailnet feedback", undefined, document);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back after a rejected Clipboard API write", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Blocked", "NotAllowedError"));
    const execCommand = vi.mocked(document.execCommand).mockReturnValue(true);

    await copyText("recovered feedback", { writeText }, document);

    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("bypasses asynchronous Clipboard API when context is explicitly insecure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.mocked(document.execCommand).mockReturnValue(true);
    const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    try {
      await copyText("insecure tailnet feedback", { writeText }, document);
    } finally {
      if (originalIsSecureContext) {
        Object.defineProperty(window, "isSecureContext", originalIsSecureContext);
      } else {
        Reflect.deleteProperty(window, "isSecureContext");
      }
    }

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("focuses, selects, and cleans up the temporary textarea during legacy copy", async () => {
    vi.mocked(document.execCommand).mockReturnValue(true);

    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const setSelectionRangeSpy = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");

    await copyText("focused feedback", undefined, document);

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(selectSpy).toHaveBeenCalled();
    expect(setSelectionRangeSpy).toHaveBeenCalledWith(0, "focused feedback".length);
    expect(document.querySelector("textarea")).toBeNull();

    focusSpy.mockRestore();
    selectSpy.mockRestore();
    setSelectionRangeSpy.mockRestore();
  });

  it("throws an error when clipboard access cannot be granted", async () => {
    vi.mocked(document.execCommand).mockReturnValue(false);

    await expect(copyText("failed feedback", undefined, document)).rejects.toThrow(
      "The browser did not grant clipboard access.",
    );
  });
});
