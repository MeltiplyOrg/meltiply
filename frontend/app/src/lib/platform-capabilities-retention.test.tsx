// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { contractSuccessBody } from "@/test/contract-fixtures";
import type {
  PlatformAccount,
  PlatformAccountsResponse,
  PlatformCapabilitiesResponse,
  PlatformCapability,
  PublishingRequirements,
} from "@/types";

import type * as ApiModule from "./api";
import {
  disconnectPlatform,
  getPlatformPublishingRequirements,
  listPlatformCapabilities,
  listPlatforms,
} from "./api";
import type { SessionScope } from "./effect";
import { privateCacheRetentionMs } from "./query-defaults";
import {
  useDisconnectPlatform,
  usePlatformCapabilities,
  usePlatformPublishingRequirements,
  usePlatforms,
} from "./queries";

vi.mock("./api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  disconnectPlatform: vi.fn(),
  getPlatformPublishingRequirements: vi.fn(),
  listPlatformCapabilities: vi.fn(),
  listPlatforms: vi.fn(),
}));

const capabilities = contractSuccessBody<PlatformCapabilitiesResponse>("listPlatformCapabilities");
const accounts = contractSuccessBody<PlatformAccountsResponse>("listPlatformAccounts");
const requirements = contractSuccessBody<PublishingRequirements>(
  "getPlatformPublishingRequirements",
);
const accountId = accounts.accounts[0]!.id;
const scope: SessionScope = {
  isSignedIn: true,
  workspaceId: "workspace-alpha",
  brandProfileId: null,
};

function capabilitySignature(items: readonly PlatformCapability[]): string {
  return items.map((item) => item.platform).join(",") || "empty";
}

function accountSignature(items: readonly PlatformAccount[]): string {
  return items.map((item) => `${item.id}:${item.connection_status}`).join(",") || "empty";
}

function CapabilityConsumer() {
  const capabilitiesQuery = usePlatformCapabilities(scope);
  const platformsQuery = usePlatforms(scope);
  const requirementsQuery = usePlatformPublishingRequirements(scope, accountId);
  const disconnectMutation = useDisconnectPlatform(scope);

  return (
    <div>
      <output aria-label="capabilities">
        {capabilitiesQuery.data === undefined
          ? "loading"
          : capabilitySignature(capabilitiesQuery.data)}
      </output>
      <output aria-label="platforms">
        {platformsQuery.data === undefined ? "loading" : accountSignature(platformsQuery.data)}
      </output>
      <output aria-label="requirements">
        {requirementsQuery.data === undefined
          ? "loading"
          : requirementsQuery.data.creator.display_name}
      </output>
      <button type="button" onClick={() => void disconnectMutation.mutateAsync(accountId)}>
        disconnect
      </button>
    </div>
  );
}

function createScopedClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: {
        gcTime: privateCacheRetentionMs,
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
        retry: false,
        staleTime: 60_000,
      },
    },
  });
}

function renderConsumer(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <CapabilityConsumer />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listPlatformCapabilities).mockReset().mockReturnValue(Effect.succeed(capabilities));
  vi.mocked(listPlatforms).mockReset().mockReturnValue(Effect.succeed(accounts));
  vi.mocked(getPlatformPublishingRequirements)
    .mockReset()
    .mockReturnValue(Effect.succeed(requirements));
  vi.mocked(disconnectPlatform).mockReset().mockReturnValue(Effect.succeed(undefined));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scoped Platform capabilities retention", () => {
  it("refreshes creator identity when the publishing surface reopens immediately", async () => {
    const client = createScopedClient();
    const first = renderConsumer(client);
    await waitFor(() =>
      expect(screen.getByLabelText("requirements")).toHaveTextContent(
        requirements.creator.display_name,
      ),
    );
    first.unmount();
    vi.mocked(getPlatformPublishingRequirements).mockReturnValue(
      Effect.succeed({
        ...requirements,
        creator: {
          ...requirements.creator,
          display_name: "Creator after account settings changed",
        },
      }),
    );
    renderConsumer(client);
    await waitFor(() =>
      expect(screen.getByLabelText("requirements")).toHaveTextContent(
        "Creator after account settings changed",
      ),
    );
  });

  it("reuses a capability read across navigation after the general freshness window", async () => {
    const client = createScopedClient();
    const first = renderConsumer(client);
    await waitFor(() =>
      expect(screen.getByLabelText("capabilities")).toHaveTextContent(
        capabilitySignature(capabilities.capabilities),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("platforms")).toHaveTextContent(
        accountSignature(accounts.accounts),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("requirements")).toHaveTextContent(
        requirements.creator.display_name,
      ),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(1);
    first.unmount();

    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    renderConsumer(client);
    await waitFor(() => expect(listPlatforms).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getPlatformPublishingRequirements).toHaveBeenCalledTimes(2));
    now.mockRestore();

    expect(screen.getByLabelText("capabilities")).toHaveTextContent(
      capabilitySignature(capabilities.capabilities),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(1);
  });

  it("keeps retained capabilities through focus and reconnect events", async () => {
    const client = createScopedClient();
    renderConsumer(client);
    await waitFor(() =>
      expect(screen.getByLabelText("capabilities")).toHaveTextContent(
        capabilitySignature(capabilities.capabilities),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("platforms")).toHaveTextContent(
        accountSignature(accounts.accounts),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("requirements")).toHaveTextContent(
        requirements.creator.display_name,
      ),
    );

    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await waitFor(() =>
      expect(vi.mocked(listPlatforms).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    now.mockRestore();

    expect(screen.getByLabelText("capabilities")).toHaveTextContent(
      capabilitySignature(capabilities.capabilities),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(1);
  });

  it("loads fresh capabilities in a replacement scoped client", async () => {
    const firstClient = createScopedClient();
    const first = renderConsumer(firstClient);
    await waitFor(() =>
      expect(screen.getByLabelText("capabilities")).toHaveTextContent(
        capabilitySignature(capabilities.capabilities),
      ),
    );
    first.unmount();

    const reducedCapabilities: PlatformCapabilitiesResponse = {
      capabilities: capabilities.capabilities.slice(1),
    };
    vi.mocked(listPlatformCapabilities).mockReturnValue(Effect.succeed(reducedCapabilities));

    renderConsumer(createScopedClient());
    await waitFor(() =>
      expect(screen.getByLabelText("capabilities")).toHaveTextContent(
        capabilitySignature(reducedCapabilities.capabilities),
      ),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(2);
  });

  it("refreshes Channel data without refetching static capabilities", async () => {
    const revokedAccounts: PlatformAccountsResponse = {
      accounts: accounts.accounts.map((account) => ({
        ...account,
        connection_status: "revoked" as const,
      })),
    };
    const updatedRequirements: PublishingRequirements = {
      ...requirements,
      creator: { ...requirements.creator, display_name: "Updated creator" },
    };
    vi.mocked(listPlatforms)
      .mockReturnValueOnce(Effect.succeed(accounts))
      .mockReturnValue(Effect.succeed(revokedAccounts));
    vi.mocked(getPlatformPublishingRequirements)
      .mockReturnValueOnce(Effect.succeed(requirements))
      .mockReturnValue(Effect.succeed(updatedRequirements));

    const client = createScopedClient();
    renderConsumer(client);
    await waitFor(() =>
      expect(screen.getByLabelText("capabilities")).toHaveTextContent(
        capabilitySignature(capabilities.capabilities),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("platforms")).toHaveTextContent(
        accountSignature(accounts.accounts),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("requirements")).toHaveTextContent(
        requirements.creator.display_name,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "disconnect" }));

    await waitFor(() =>
      expect(screen.getByLabelText("platforms")).toHaveTextContent(
        accountSignature(revokedAccounts.accounts),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("requirements")).toHaveTextContent("Updated creator"),
    );

    expect(disconnectPlatform).toHaveBeenCalledTimes(1);
    expect(listPlatforms).toHaveBeenCalledTimes(2);
    expect(getPlatformPublishingRequirements).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("capabilities")).toHaveTextContent(
      capabilitySignature(capabilities.capabilities),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(1);
  });
});
