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
import {
  useDisconnectPlatform,
  usePlatformCapabilities,
  usePlatformPublishingRequirements,
  usePlatforms,
} from "./queries";

// Exercise the real frontend Effect layer, query hooks, mutation invalidations,
// and QueryClient. Only the HTTP adapter is replaced so each test can observe
// transport work and return distinguishable data without a browser or API.
vi.mock("./api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  disconnectPlatform: vi.fn(),
  getPlatformPublishingRequirements: vi.fn(),
  listPlatformCapabilities: vi.fn(),
  listPlatforms: vi.fn(),
}));

const capabilities = contractSuccessBody<PlatformCapabilitiesResponse>("listPlatformCapabilities");
const accounts = contractSuccessBody<PlatformAccountsResponse>("listPlatformAccounts");
const requirements =
  contractSuccessBody<PublishingRequirements>("getPlatformPublishingRequirements");
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

/**
 * Mounts the shared capability/platform/requirement query hooks as a rendered
 * consumer. It deliberately uses the production hooks instead of query-option
 * assertions so the tests observe what a surface receives and what reaches the
 * transport adapter.
 */
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

/** Mirrors the production scoped-client defaults that own the 60-second policy. */
function createScopedClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: {
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
  /**
   * Navigation remounts consumers but keeps the Workspace-scoped QueryClient.
   * Advancing past the 60-second general policy proves the capability read is
   * reused while an ordinary query and the dynamic requirement read still
   * refresh at their existing freshness.
   */
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

  /**
   * Tab focus and network reconnect are explicit invalidation-adjacent events.
   * A retained successful capability result must survive them, while the
   * dynamic requirement and general platform reads still refresh because they
   * remain stale under their unchanged policies.
   */
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
    await waitFor(() => expect(vi.mocked(listPlatforms).mock.calls.length).toBeGreaterThanOrEqual(2));
    now.mockRestore();

    expect(screen.getByLabelText("capabilities")).toHaveTextContent(
      capabilitySignature(capabilities.capabilities),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(1);
  });

  /**
   * A replacement scoped QueryClient represents sign-out or an identity or
   * Workspace switch. It starts empty, loads fresh data, and cannot display the
   * previous client's retained capabilities.
   */
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

  /**
   * Unmounting starts the query's garbage-collection timer. Retained capability
   * lifetime must outlast the ordinary five-minute window so returning to a
   * surface after a long absence still reuses the successful result.
   */
  it("retains capabilities beyond the default garbage-collection window", async () => {
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

    vi.useFakeTimers();
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    vi.useRealTimers();

    renderConsumer(client);
    await waitFor(() => expect(listPlatforms).toHaveBeenCalledTimes(2));

    expect(screen.getByLabelText("capabilities")).toHaveTextContent(
      capabilitySignature(capabilities.capabilities),
    );
    expect(listPlatformCapabilities).toHaveBeenCalledTimes(1);
  });

  /**
   * Disconnecting an account invalidates its account data and publishing
   * requirements. The rendered consumer must receive the refreshed dynamic
   * values while the static capability array remains the same retained read.
   */
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
