import { useCallback, useMemo, useState } from "react";
import { Navigate } from "react-router";
import { Crown, MoreHorizontal, ShieldCheck, UserPlus, Users } from "lucide-react";

import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import {
  useCreateWorkspaceInvitation,
  useDeleteInstallationMember,
  useInstallation,
  useReactivateInstallationMember,
  useRemoveWorkspaceMember,
  useRenameWorkspace,
  useResendWorkspaceInvitation,
  useRevokeWorkspaceInvitation,
  useSuspendInstallationMember,
  useTransferInstallationOwnership,
  useUpdateWorkspaceMember,
  useWorkspaceAudit,
  useWorkspaceInvitations,
  useWorkspaceMembers,
} from "@/lib/queries";
import { toast } from "@meltiply/ui/toast";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import {
  CenterAlertDialog,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogFooter,
  CenterDialogHeader,
  CenterDialogTitle,
} from "@meltiply/ui/center-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";
import { Input } from "@meltiply/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { StatusPill } from "@meltiply/ui/status-pill";
import { Switch } from "@meltiply/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meltiply/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@meltiply/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import {
  AUDIT_PAGE_SIZE,
  AuditLogTable,
  type AuditFilters,
} from "@/components/settings/audit-log-table";
import type { WorkspaceMember, WorkspaceRole } from "@/types";

const ROLE_ORDER: readonly WorkspaceRole[] = ["admin", "editor", "viewer"];

/**
 * Returns the roles the current caller may assign.
 *
 * Workspace Admins may assign Editor and Viewer; only the Installation Owner
 * may assign Admin. The server enforces the same capability map.
 *
 * @param installationOwner - Whether the caller owns the installation.
 * @returns Assignable roles in descending authority order.
 */
function assignableRoles(installationOwner: boolean): readonly WorkspaceRole[] {
  return installationOwner ? ROLE_ORDER : (["editor", "viewer"] as const);
}

/**
 * Formats a Workspace member display name with the email fallback.
 *
 * @param member - Member row.
 * @returns Display label.
 */
function memberLabel(member: WorkspaceMember): string {
  return member.display_name?.trim() || member.email;
}

/**
 * Renders the installation settings surface: Members, Workspace, and Audit.
 *
 * The route and tabs are visible only to Workspace Admins and the Installation
 * Owner. Every action is also authorized server-side; hiding controls is a
 * usability affordance, never the authorization boundary.
 *
 * @param props.embedded - When true, render inside the master Settings shell
 *   without repeating its page header.
 * @returns React element rendering the settings page or a redirect for non-admins.
 */
export default function SettingsPage({
  embedded = false,
}: {
  embedded?: boolean;
} = {}): React.ReactElement {
  const { t } = useI18n();
  const { canManageSettings, isInstallationOwner, isLoading, user } = useWorkspace();
  const scope = useSessionScope();
  const workspaceId = user?.orgId ?? "";

  const installation = useInstallation(scope, workspaceId, canManageSettings && !!workspaceId);
  const membersQuery = useWorkspaceMembers(scope, workspaceId, canManageSettings && !!workspaceId);
  const invitationsQuery = useWorkspaceInvitations(
    scope,
    workspaceId,
    canManageSettings && !!workspaceId,
  );
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({
    action: "",
    q: "",
    targetType: "",
  });
  const [auditOffset, setAuditOffset] = useState(0);
  const auditQuery = useWorkspaceAudit(
    scope,
    workspaceId,
    {
      action: auditFilters.action || undefined,
      limit: AUDIT_PAGE_SIZE,
      offset: auditOffset,
      q: auditFilters.q || undefined,
      target_type: auditFilters.targetType || undefined,
    },
    canManageSettings && !!workspaceId,
  );

  const invite = useCreateWorkspaceInvitation(scope);
  const resend = useResendWorkspaceInvitation(scope);
  const revoke = useRevokeWorkspaceInvitation(scope);
  const updateRole = useUpdateWorkspaceMember(scope);
  const removeMember = useRemoveWorkspaceMember(scope);
  const suspendMember = useSuspendInstallationMember(scope);
  const reactivateMember = useReactivateInstallationMember(scope);
  const deleteMember = useDeleteInstallationMember(scope);
  const transferOwner = useTransferInstallationOwnership(scope);
  const renameWorkspace = useRenameWorkspace(scope);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("editor");
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMember | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMember | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferPassword, setTransferPassword] = useState("");
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState<string | null>(null);

  // Every filter change restarts at the first page; the audit table keeps the
  // search input's local text until its debounce delivers it here.
  const applyAuditFilters = useCallback((patch: Partial<AuditFilters>) => {
    setAuditFilters((previous) => ({ ...previous, ...patch }));
    setAuditOffset(0);
  }, []);
  const handleAuditSearch = useCallback(
    (q: string) => applyAuditFilters({ q }),
    [applyAuditFilters],
  );
  const resetAuditFilters = useCallback(() => {
    setAuditFilters({ action: "", q: "", targetType: "" });
    setAuditOffset(0);
  }, []);

  const members = useMemo(() => membersQuery.data?.members ?? [], [membersQuery.data]);
  const workspaceNameValue = workspaceNameDraft ?? installation.data?.workspace.name ?? "";
  const invitations = invitationsQuery.data?.invitations ?? [];
  const roles = assignableRoles(isInstallationOwner);
  const transferCandidates = useMemo(
    () =>
      members.filter(
        (member) =>
          member.role === "admin" && member.status === "active" && !member.is_installation_owner,
      ),
    [members],
  );

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-ink-2">
        {t("Loading settings…")}
      </p>
    );
  }

  if (user && !canManageSettings) {
    return <Navigate to="/posts" replace />;
  }

  const error =
    (invitationsQuery.error instanceof Error ? invitationsQuery.error.message : null) ??
    (membersQuery.error instanceof Error ? membersQuery.error.message : null) ??
    (auditQuery.error instanceof Error ? auditQuery.error.message : null) ??
    (installation.error instanceof Error ? installation.error.message : null);

  const runInvite = async () => {
    try {
      await invite.mutateAsync({
        email: inviteEmail.trim(),
        role: inviteRole,
        workspaceId,
      });
      setInviteEmail("");
      setInviteOpen(false);
      toast(t("Invitation sent"), {
        description: t("The invitation email carries a single-use acceptance link."),
        variant: "success",
      });
    } catch (cause) {
      toast(t("The invitation could not be sent"), {
        description: cause instanceof Error ? cause.message : t("Try again in a moment."),
        variant: "error",
      });
    }
  };

  const runWorkspaceRename = async () => {
    const name = workspaceNameValue.trim();
    if (!name) return;
    try {
      await renameWorkspace.mutateAsync({ name, workspaceId });
      setWorkspaceNameDraft(null);
      toast(t("Workspace renamed"), {
        description: t("The new name is visible to every member."),
        variant: "success",
      });
    } catch (cause) {
      toast(t("The workspace could not be renamed"), {
        description: cause instanceof Error ? cause.message : t("Try again in a moment."),
        variant: "error",
      });
    }
  };

  return (
    <section
      className={
        embedded ? "flex min-h-0 flex-1 flex-col gap-4" : "mx-auto w-full max-w-300 space-y-6"
      }
    >
      {!embedded && (
        <header className="space-y-2">
          <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-ink-3">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {t("Administration")}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("Settings")}</h1>
          <p className="text-sm leading-relaxed text-ink-2">
            {t(
              "Manage who can access this installation, the shared workspace, and its audit trail.",
            )}
          </p>
        </header>
      )}

      {error && (
        <Alert variant="destructive">
          {t("Some settings could not be loaded. Try again in a moment.")}
        </Alert>
      )}

      <Tabs defaultValue="members" className="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList id="settings-tabs" className="self-start justify-start">
          <TabsTrigger value="members">
            <Users className="mr-2 size-4" aria-hidden="true" />
            {t("Members")}
          </TabsTrigger>
          <TabsTrigger value="workspace">{t("Workspace")}</TabsTrigger>
          <TabsTrigger value="audit">{t("Audit")}</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="mt-0 flex min-h-0 flex-1 flex-col gap-4">
          <section aria-labelledby="members-heading" className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 id="members-heading" className="text-sm font-semibold text-ink">
                  {t("Members")}
                </h2>
                <p className="text-xs text-ink-3">
                  {t("Roles decide who can publish, configure channels, and administer access.")}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={
                  !canManageSettings ||
                  (installation.data?.seats_used ?? 0) >= (installation.data?.seat_limit ?? 10)
                }
                onClick={() => {
                  setInviteRole(roles[0] ?? "editor");
                  setInviteOpen(true);
                }}
              >
                <UserPlus className="size-4" aria-hidden="true" />
                {t("Invite")}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-card border border-line bg-surface">
              <TooltipProvider>
                <Table
                  variant="spreadsheet"
                  className="min-w-170"
                  aria-label={t("Workspace members")}
                >
                  <colgroup>
                    <col />
                    <col className="w-33" />
                    <col className="w-40" />
                    <col className="w-12" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Member")}</TableHead>
                      <TableHead>{t("Role")}</TableHead>
                      <TableHead>{t("Status")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {membersQuery.isPending ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-10 text-sm text-ink-2">
                          <span role="status">{t("Loading members…")}</span>
                        </TableCell>
                      </TableRow>
                    ) : members.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-10 text-sm text-ink-2">
                          {t("No members yet.")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      members.map((member) => (
                        <MemberRow
                          key={member.user_id}
                          actorUserId={user?.id ?? ""}
                          assignableRoles={roles}
                          canSuspend={isInstallationOwner}
                          isInstallationOwner={isInstallationOwner}
                          member={member}
                          onDelete={() => {
                            setDeleteConfirmation("");
                            setDeleteTarget(member);
                          }}
                          onReactivate={() =>
                            reactivateMember.mutate(
                              { memberId: member.user_id, workspaceId },
                              {
                                onError: (cause) =>
                                  toast(t("The member could not be reactivated"), {
                                    description:
                                      cause instanceof Error
                                        ? cause.message
                                        : t("Try again in a moment."),
                                    variant: "error",
                                  }),
                                onSuccess: () =>
                                  toast(t("Member reactivated"), {
                                    description: t("The member can sign in again."),
                                    variant: "success",
                                  }),
                              },
                            )
                          }
                          onRemove={() => setRemoveTarget(member)}
                          onRoleChange={(role) =>
                            updateRole.mutate(
                              { memberId: member.user_id, role, workspaceId },
                              {
                                onError: (cause) =>
                                  toast(t("The role could not be changed"), {
                                    description:
                                      cause instanceof Error
                                        ? cause.message
                                        : t("Try again in a moment."),
                                    variant: "error",
                                  }),
                                onSuccess: () =>
                                  toast(t("Role updated"), {
                                    description: t(
                                      "The change applies on the member’s next request.",
                                    ),
                                    variant: "success",
                                  }),
                              },
                            )
                          }
                          onSuspend={() =>
                            suspendMember.mutate(
                              { memberId: member.user_id, reason: undefined, workspaceId },
                              {
                                onError: (cause) =>
                                  toast(t("The member could not be suspended"), {
                                    description:
                                      cause instanceof Error
                                        ? cause.message
                                        : t("Try again in a moment."),
                                    variant: "error",
                                  }),
                                onSuccess: () =>
                                  toast(t("Member suspended"), {
                                    description: t(
                                      "Their sessions were revoked and the Seat was freed.",
                                    ),
                                    variant: "success",
                                  }),
                              },
                            )
                          }
                        />
                      ))
                    )}
                  </TableBody>
                </Table>
              </TooltipProvider>
            </div>
          </section>

          <section
            aria-labelledby="invitations-heading"
            className="flex max-h-[35%] min-h-0 shrink-0 flex-col gap-2"
          >
            <div>
              <h2 id="invitations-heading" className="text-sm font-semibold text-ink">
                {t("Pending invitations")}
              </h2>
              <p className="text-xs text-ink-3">
                {t("Pending invitations reserve a Seat until they are accepted or revoked.")}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-card border border-line bg-surface">
              <Table
                variant="spreadsheet"
                className="min-w-140"
                aria-label={t("Pending invitations")}
              >
                <colgroup>
                  <col />
                  <col className="w-33" />
                  <col className="w-32" />
                  <col className="w-48" />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Email")}</TableHead>
                    <TableHead>{t("Role")}</TableHead>
                    <TableHead>{t("Expires")}</TableHead>
                    <TableHead>{t("Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-10 text-sm text-ink-2">
                        {t("No pending invitations.")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    invitations.map((invitation) => (
                      <TableRow key={invitation.id}>
                        <TableCell>
                          <span className="truncate text-sm font-medium text-ink">
                            {invitation.email}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusPill tone="neutral">{roleLabel(t, invitation.role)}</StatusPill>
                        </TableCell>
                        <TableCell>
                          <time
                            dateTime={invitation.expires_at}
                            className="whitespace-nowrap text-xs text-ink-3"
                          >
                            {new Date(invitation.expires_at).toLocaleDateString()}
                          </time>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={resend.isPending}
                              onClick={() =>
                                resend.mutate(
                                  { invitationId: invitation.id, workspaceId },
                                  {
                                    onError: (cause) =>
                                      toast(t("The invitation could not be resent"), {
                                        description:
                                          cause instanceof Error
                                            ? cause.message
                                            : t("Try again in a moment."),
                                        variant: "error",
                                      }),
                                    onSuccess: () =>
                                      toast(t("Invitation resent"), {
                                        description: t("The previous link no longer works."),
                                        variant: "success",
                                      }),
                                  },
                                )
                              }
                            >
                              {t("Resend")}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={revoke.isPending}
                              onClick={() =>
                                revoke.mutate(
                                  { invitationId: invitation.id, workspaceId },
                                  {
                                    onError: (cause) =>
                                      toast(t("The invitation could not be revoked"), {
                                        description:
                                          cause instanceof Error
                                            ? cause.message
                                            : t("Try again in a moment."),
                                        variant: "error",
                                      }),
                                    onSuccess: () =>
                                      toast(t("Invitation revoked"), {
                                        description: t("The reserved Seat is free again."),
                                        variant: "success",
                                      }),
                                  },
                                )
                              }
                            >
                              {t("Revoke")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="workspace" className="mt-0 min-h-0 flex-1 overflow-y-auto pr-1">
          <section aria-labelledby="workspace-heading" className="max-w-2xl space-y-6">
            <div className="space-y-1">
              <h2 id="workspace-heading" className="text-sm font-semibold text-ink">
                {t("Workspace")}
              </h2>
              <p className="text-sm text-ink-2">
                {t("Every member shares this workspace. There is no personal workspace.")}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
              <label htmlFor="workspace-name" className="text-sm font-medium text-ink">
                {t("Workspace name")}
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="workspace-name"
                  className="w-full max-w-sm"
                  maxLength={200}
                  value={workspaceNameValue}
                  onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                />
                <Button
                  type="button"
                  disabled={
                    renameWorkspace.isPending ||
                    !workspaceNameValue.trim() ||
                    workspaceNameValue.trim() === installation.data?.workspace.name
                  }
                  onClick={() => void runWorkspaceRename()}
                >
                  {renameWorkspace.isPending ? t("Saving…") : t("Save name")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 border-t border-line pt-5 sm:grid-cols-[180px_minmax(0,1fr)]">
              <h3 className="text-sm font-medium text-ink">{t("Seat usage")}</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-ink-3">{t("Seats used")}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-ink">
                    {installation.data?.seats_used ?? 0} / {installation.data?.seat_limit ?? 10}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">{t("Active members")}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-ink">
                    {installation.data?.members_active ?? 0}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">{t("Pending invitations")}</dt>
                  <dd className="mt-0.5 font-medium tabular-nums text-ink">
                    {installation.data?.invitations_pending ?? 0}
                  </dd>
                </div>
              </dl>
            </div>
            {isInstallationOwner && (
              <div className="grid gap-3 border-t border-line pt-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-start">
                <h3 className="text-sm font-medium text-ink">{t("Installation ownership")}</h3>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-md text-xs leading-relaxed text-ink-3">
                    {t(
                      "Transfer ownership to an active Workspace Admin after confirming your password.",
                    )}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={transferCandidates.length === 0}
                    onClick={() => {
                      setTransferTarget(transferCandidates[0]?.user_id ?? "");
                      setTransferOpen(true);
                    }}
                  >
                    {t("Transfer ownership")}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="audit" className="mt-0 flex min-h-0 flex-1 flex-col gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-ink">{t("Audit")}</h2>
            <p className="text-sm text-ink-2">
              {t("Administrative actions are recorded with the actor, target, and request id.")}
            </p>
          </div>
          <AuditLogTable
            entries={auditQuery.data?.entries ?? []}
            filters={auditFilters}
            hasMore={auditQuery.data?.has_more ?? false}
            isPending={auditQuery.isPending}
            isRefreshing={auditQuery.isFetching}
            offset={auditOffset}
            onActionChange={(action) => applyAuditFilters({ action })}
            onOffsetChange={setAuditOffset}
            onRefresh={() => void auditQuery.refetch()}
            onReset={resetAuditFilters}
            onSearchChange={handleAuditSearch}
            onTargetTypeChange={(targetType) => applyAuditFilters({ targetType })}
          />
        </TabsContent>
      </Tabs>

      <CenterDialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <CenterDialogContent closeLabel={t("Close")} aria-describedby={undefined}>
          <CenterDialogHeader>
            <CenterDialogTitle>{t("Invite a member")}</CenterDialogTitle>
            <CenterDialogDescription>
              {t("The invitation is bound to this email and expires in seven days.")}
            </CenterDialogDescription>
          </CenterDialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="invite-email" className="text-sm font-medium text-ink">
                {t("Email address")}
              </label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="invite-role" className="text-sm font-medium text-ink">
                {t("Role")}
              </label>
              <Select
                value={inviteRole}
                onValueChange={(value) => setInviteRole(value as WorkspaceRole)}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabel(t, role)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <CenterDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              disabled={invite.isPending || !inviteEmail.trim()}
              onClick={() => void runInvite()}
            >
              {invite.isPending ? t("Sending…") : t("Send invitation")}
            </Button>
          </CenterDialogFooter>
        </CenterDialogContent>
      </CenterDialog>

      <CenterAlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <CenterAlertDialogContent aria-describedby={undefined}>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>{t("Remove this member?")}</CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "Their Workspace membership is removed and the Seat is freed. The account and its content attribution remain.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel>{t("Cancel")}</CenterAlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={removeMember.isPending || !removeTarget}
              onClick={() => {
                if (!removeTarget) return;
                removeMember.mutate(
                  { memberId: removeTarget.user_id, workspaceId },
                  {
                    onError: (cause) =>
                      toast(t("The member could not be removed"), {
                        description:
                          cause instanceof Error ? cause.message : t("Try again in a moment."),
                        variant: "error",
                      }),
                    onSuccess: () => {
                      setRemoveTarget(null);
                      toast(t("Member removed"), {
                        description: t("The Workspace membership was removed."),
                        variant: "success",
                      });
                    },
                  },
                );
              }}
            >
              {removeMember.isPending ? t("Removing…") : t("Remove member")}
            </Button>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>

      <CenterAlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <CenterAlertDialogContent aria-describedby={undefined}>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>{t("Delete this account?")}</CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "This permanently removes the account and its sessions. Workspace content stays intact.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          {deleteTarget && (
            <div className="space-y-2">
              <label htmlFor="delete-confirm" className="text-sm font-medium text-ink">
                {t("Type {email} to confirm", { email: deleteTarget.email })}
              </label>
              <Input
                id="delete-confirm"
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
              />
            </div>
          )}
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel>{t("Cancel")}</CenterAlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={
                deleteMember.isPending ||
                !deleteTarget ||
                deleteConfirmation.trim().toLowerCase() !== deleteTarget.email.toLowerCase()
              }
              onClick={() => {
                if (!deleteTarget) return;
                deleteMember.mutate(
                  {
                    confirmEmail: deleteTarget.email,
                    memberId: deleteTarget.user_id,
                    workspaceId,
                  },
                  {
                    onError: (cause) =>
                      toast(t("The account could not be deleted"), {
                        description:
                          cause instanceof Error ? cause.message : t("Try again in a moment."),
                        variant: "error",
                      }),
                    onSuccess: () => {
                      setDeleteTarget(null);
                      toast(t("Account deleted"), {
                        description: t("The membership and credentials were removed."),
                        variant: "success",
                      });
                    },
                  },
                );
              }}
            >
              {deleteMember.isPending ? t("Deleting…") : t("Delete account")}
            </Button>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>

      <CenterDialog open={transferOpen} onOpenChange={setTransferOpen}>
        <CenterDialogContent closeLabel={t("Close")} aria-describedby={undefined}>
          <CenterDialogHeader>
            <CenterDialogTitle>{t("Transfer installation ownership")}</CenterDialogTitle>
            <CenterDialogDescription>
              {t("You remain a Workspace Admin after the transfer.")}
            </CenterDialogDescription>
          </CenterDialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="transfer-target" className="text-sm font-medium text-ink">
                {t("New Installation Owner")}
              </label>
              <Select value={transferTarget} onValueChange={setTransferTarget}>
                <SelectTrigger id="transfer-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {transferCandidates.map((member) => (
                    <SelectItem key={member.user_id} value={member.user_id}>
                      {memberLabel(member)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="transfer-password" className="text-sm font-medium text-ink">
                {t("Your password")}
              </label>
              <Input
                id="transfer-password"
                type="password"
                autoComplete="current-password"
                value={transferPassword}
                onChange={(event) => setTransferPassword(event.target.value)}
              />
            </div>
          </div>
          <CenterDialogFooter>
            <Button type="button" variant="ghost" onClick={() => setTransferOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              disabled={transferOwner.isPending || !transferTarget || !transferPassword}
              onClick={() => {
                transferOwner.mutate(
                  { password: transferPassword, targetUserId: transferTarget, workspaceId },
                  {
                    onError: (cause) =>
                      toast(t("Ownership could not be transferred"), {
                        description:
                          cause instanceof Error ? cause.message : t("Try again in a moment."),
                        variant: "error",
                      }),
                    onSuccess: () => {
                      setTransferOpen(false);
                      setTransferPassword("");
                      toast(t("Ownership transferred"), {
                        description: t("You remain a Workspace Admin."),
                        variant: "success",
                      });
                    },
                  },
                );
              }}
            >
              {transferOwner.isPending ? t("Transferring…") : t("Transfer ownership")}
            </Button>
          </CenterDialogFooter>
        </CenterDialogContent>
      </CenterDialog>
    </section>
  );
}

/**
 * Renders one member row with role and lifecycle controls the caller may use.
 *
 * @param props - Member, caller capabilities, and action callbacks.
 * @returns Member row element.
 */
function MemberRow({
  actorUserId,
  assignableRoles: roles,
  canSuspend,
  isInstallationOwner,
  member,
  onDelete,
  onReactivate,
  onRemove,
  onRoleChange,
  onSuspend,
}: {
  actorUserId: string;
  assignableRoles: readonly WorkspaceRole[];
  canSuspend: boolean;
  isInstallationOwner: boolean;
  member: WorkspaceMember;
  onDelete: () => void;
  onReactivate: () => void;
  onRemove: () => void;
  onRoleChange: (role: WorkspaceRole) => void;
  onSuspend: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const isSelf = member.user_id === actorUserId;
  const isOwnerRow = member.is_installation_owner;
  const roleLocked = isOwnerRow || (member.role === "admin" && !isInstallationOwner) || isSelf;
  const canLifecycle = canSuspend && !isSelf && !isOwnerRow;
  const canRemove = !isSelf && !isOwnerRow && (isInstallationOwner || member.role !== "admin");
  const canDelete = canLifecycle;
  const active = member.status === "active";
  return (
    <TableRow data-testid={`member-row-${member.user_id}`}>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="size-6">
            <AvatarImage src={member.avatar_url ?? undefined} alt="" />
            <AvatarFallback>{memberLabel(member).slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate text-(length:--font-size-ui) font-medium text-ink">
            {memberLabel(member)}
            {isSelf ? ` · ${t("You")}` : ""}
          </span>
          {isOwnerRow && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={t("Installation Owner")}
                  className="inline-flex shrink-0 items-center rounded-chip outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Crown className="size-3.5 text-orange" aria-hidden="true" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("Installation Owner")}</TooltipContent>
            </Tooltip>
          )}
          <span className="hidden truncate text-xs text-ink-3 sm:inline">{member.email}</span>
        </div>
      </TableCell>
      <TableCell>
        <Select
          value={member.role}
          onValueChange={(value) => onRoleChange(value as WorkspaceRole)}
          disabled={roleLocked}
        >
          <SelectTrigger
            className="h-7 w-28"
            aria-label={t("Role for {name}", { name: memberLabel(member) })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_ORDER.filter((role) => roles.includes(role) || role === member.role).map(
              (role) => (
                <SelectItem key={role} value={role}>
                  {roleLabel(t, role)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          <Switch
            checked={active}
            disabled={!canLifecycle}
            aria-label={t("Toggle active state for {name}", { name: memberLabel(member) })}
            onCheckedChange={(checked) => {
              if (checked) onReactivate();
              else onSuspend();
            }}
          />
          <span className="text-xs text-ink-2">{active ? t("Active") : t("Suspended")}</span>
        </span>
      </TableCell>
      <TableCell className="text-right">
        {(canRemove || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("Actions for {name}", { name: memberLabel(member) })}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canRemove && <DropdownMenuItem onSelect={onRemove}>{t("Remove")}</DropdownMenuItem>}
              {canRemove && canDelete && <DropdownMenuSeparator />}
              {canDelete && (
                <DropdownMenuItem className="text-red focus:text-red" onSelect={onDelete}>
                  {t("Delete account")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Maps a Workspace role to its translated display label.
 *
 * @param t - Translation function from the active i18n context.
 * @param role - Workspace role.
 * @returns Human-readable role label.
 */
function roleLabel(t: (message: string) => string, role: WorkspaceRole): string {
  return role === "admin" ? t("Admin") : role === "editor" ? t("Editor") : t("Viewer");
}
