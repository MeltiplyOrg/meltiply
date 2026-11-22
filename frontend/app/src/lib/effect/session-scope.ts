import { Context } from "effect";

export interface SessionScope {
  readonly isSignedIn: boolean;
  readonly workspaceId: string | null;
  readonly brandProfileId: string | null;
}

export interface WorkspaceServiceShape {
  readonly workspaceId: string | null;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  "WorkspaceService",
) {}
