import { useMemo, useState } from "react";
import { Navigate } from "react-router";
import { ShieldCheck, UserPlus, Users } from "lucide-react";

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
import { Card, CardContent, CardHeader } from "@meltiply/ui/card";
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
import { Input } from "@meltiply/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { StatusPill } from "@meltiply/ui/status-pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@meltiply/ui/tabs";
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
  const auditQuery = useWorkspaceAudit(
    scope,
    workspaceId,
    { limit: 50 },
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
    <section className={embedded ? "w-full space-y-6" : "mx-auto w-full max-w-5xl space-y-6"}>
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

      <Tabs defaultValue="members" className="space-y-4">
        <TabsList id="settings-tabs" className="w-full justify-start gap-1">
          <TabsTrigger value="members">
            <Users className="mr-2 size-4" aria-hidden="true" />
            {t("Members")}
          </TabsTrigger>
          <TabsTrigger value="workspace">{t("Workspace")}</TabsTrigger>
          <TabsTrigger value="audit">{t("Audit")}</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="space-y-1">
                <h3 className="font-semibold leading-none tracking-tight">{t("Members")}</h3>
                <p className="text-sm text-ink-2">
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
            </CardHeader>
            <CardContent className="space-y-3">
              {membersQuery.isPending ? (
                <p role="status" className="text-sm text-ink-2">
                  {t("Loading members…")}
                </p>
              ) : members.length === 0 ? (
                <p className="text-sm text-ink-2">{t("No members yet.")}</p>
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
                              description: t("The change applies on the member’s next request."),
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
                              description: t("Their sessions were revoked and the Seat was freed."),
                              variant: "success",
                            }),
                        },
                      )
                    }
                  />
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h3 className="font-semibold leading-none tracking-tight">
                {t("Pending invitations")}
              </h3>
              <p className="text-sm text-ink-2">
                {t("Pending invitations reserve a Seat until they are accepted or revoked.")}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {invitations.length === 0 ? (
                <p className="text-sm text-ink-2">{t("No pending invitations.")}</p>
              ) : (
                invitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line-soft px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{invitation.email}</p>
                      <p className="text-xs text-ink-3">
                        {t("Expires {date}", {
                          date: new Date(invitation.expires_at).toLocaleDateString(),
                        })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill tone="neutral">{roleLabel(t, invitation.role)}</StatusPill>
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
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="workspace" className="space-y-6">
          <Card>
            <CardHeader>
              <h3 className="font-semibold leading-none tracking-tight">{t("Workspace")}</h3>
              <p className="text-sm text-ink-2">
                {t("Every member shares this workspace. There is no personal workspace.")}
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="workspace-name" className="text-sm font-medium text-ink">
                  {t("Workspace name")}
                </label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="workspace-name"
                    className="max-w-sm"
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
              <div className="grid gap-3 sm:grid-cols-3">
                <SeatMetric
                  label={t("Seats used")}
                  value={`${installation.data?.seats_used ?? 0} / ${installation.data?.seat_limit ?? 10}`}
                />
                <SeatMetric
                  label={t("Active members")}
                  value={String(installation.data?.members_active ?? 0)}
                />
                <SeatMetric
                  label={t("Pending invitations")}
                  value={String(installation.data?.invitations_pending ?? 0)}
                />
              </div>
              {isInstallationOwner && (
                <div className="flex flex-col gap-2 border-t border-line-soft pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink">{t("Installation ownership")}</p>
                    <p className="text-xs leading-relaxed text-ink-3">
                      {t(
                        "Transfer ownership to an active Workspace Admin after confirming your password.",
                      )}
                    </p>
                  </div>
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
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <h3 className="font-semibold leading-none tracking-tight">{t("Audit")}</h3>
              <p className="text-sm text-ink-2">
                {t("Administrative actions are recorded with the actor, target, and request id.")}
              </p>
            </CardHeader>
            <CardContent>
              {auditQuery.isPending ? (
                <p role="status" className="text-sm text-ink-2">
                  {t("Loading audit entries…")}
                </p>
              ) : auditQuery.data?.entries.length ? (
                <ol className="divide-y divide-line-soft">
                  {auditQuery.data.entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-start justify-between gap-3 py-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-medium text-ink">{entry.action}</p>
                        <p className="truncate text-xs text-ink-3">
                          {entry.actor.email} · {entry.target_type}: {entry.target_id}
                        </p>
                      </div>
                      <time className="shrink-0 text-xs text-ink-3" dateTime={entry.created_at}>
                        {new Date(entry.created_at).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-ink-2">{t("No audit entries yet.")}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <CenterDialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <CenterDialogContent aria-describedby={undefined}>
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
        <CenterDialogContent aria-describedby={undefined}>
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
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line-soft px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-8">
          <AvatarImage src={member.avatar_url ?? undefined} alt="" />
          <AvatarFallback>{memberLabel(member).slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {memberLabel(member)}
            {isSelf ? ` · ${t("You")}` : ""}
          </p>
          <p className="truncate text-xs text-ink-3">{member.email}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={member.status === "active" ? "green" : "orange"}>
          {member.status === "active" ? t("Active") : t("Suspended")}
        </StatusPill>
        {isOwnerRow && <StatusPill tone="accent">{t("Installation Owner")}</StatusPill>}
        <Select
          value={member.role}
          onValueChange={(value) => onRoleChange(value as WorkspaceRole)}
          disabled={roleLocked}
        >
          <SelectTrigger
            className="h-8 w-32"
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
        {canLifecycle &&
          (member.status === "active" ? (
            <Button type="button" variant="outline" size="sm" onClick={onSuspend}>
              {t("Suspend")}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={onReactivate}>
              {t("Reactivate")}
            </Button>
          ))}
        {!isSelf && !isOwnerRow && (isInstallationOwner || member.role !== "admin") && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            {t("Remove")}
          </Button>
        )}
        {canLifecycle && (
          <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
            {t("Delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Renders one Seat metric.
 *
 * @param props.label - Metric label.
 * @param props.value - Formatted metric value.
 * @returns Metric element.
 */
function SeatMetric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-control border border-line-soft px-3 py-2">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="text-lg font-semibold tracking-tight text-ink">{value}</p>
    </div>
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
