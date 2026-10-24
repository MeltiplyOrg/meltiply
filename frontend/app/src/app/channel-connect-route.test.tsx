// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/app/providers", () => ({
  AppProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/context/workspace.context", () => ({
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/channels/channel-assignment", () => ({
  ChannelAssignment: ({
    onClose,
    onSuccess,
    selectionId,
  }: {
    onClose: () => void;
    onSuccess: () => void;
    selectionId: string;
  }) => (
    <div data-testid="channel-assignment" data-selection-id={selectionId}>
      <button onClick={() => onSuccess()}>Assign channel</button>
      <button onClick={onClose}>Cancel</button>
    </div>
  ),
}));

import ChannelConnectRoute from "./channel-connect-route";

afterEach(cleanup);

/** Reports the router location so navigation assertions observe the settled URL. */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderRoute(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/channels/connect" element={<ChannelConnectRoute />} />
        <Route path="/channels" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Channel connect route", () => {
  it("renders only the assignment view for the callback's selection ticket", () => {
    renderRoute("/channels/connect?selection_id=ticket-1&provider=facebook");

    expect(screen.getByTestId("channel-assignment")).toHaveAttribute(
      "data-selection-id",
      "ticket-1",
    );
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });

  it("returns to Channels with the connected outcome after assignment", () => {
    renderRoute("/channels/connect?selection_id=ticket-1&provider=facebook");

    fireEvent.click(screen.getByRole("button", { name: "Assign channel" }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/channels?oauth=connected&provider=facebook",
    );
  });

  it("returns to Channels without an outcome when assignment is dismissed", () => {
    renderRoute("/channels/connect?selection_id=ticket-1&provider=facebook");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/channels");
    expect(screen.getByTestId("location")).not.toHaveTextContent("oauth=");
  });

  it("leaves for Channels when the callback omitted a selection ticket", async () => {
    renderRoute("/channels/connect?provider=facebook");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/channels"));
    expect(screen.queryByTestId("channel-assignment")).not.toBeInTheDocument();
  });
});
