import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, MailCheck, ShieldCheck } from "lucide-react";

import { AuthBoundary } from "@/components/auth/auth-boundary";
import { useMeltiplyAuth } from "@/components/auth/auth-provider";
import { AppProviders } from "@/app/providers";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useInvitationPreview } from "@/lib/queries";
import { useAcceptWorkspaceInvitation } from "@/lib/queries";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Alert } from "@meltiply/ui/alert";
import { BrandMark } from "@meltiply/ui/brand-mark";

/**
 * Renders the invitation acceptance journey for a new or existing account.
 *
 * A new account signs up with the invited email locked and the token header
 * supplied to Better Auth; deployment policy requires email verification, and
 * membership activates automatically after verification. A signed-in visitor
 * accepts the token directly. The preview resolves before sign-in because token
 * possession is the credential for reading the invitation.
 *
 * @returns React element rendering the acceptance surface.
 */
export default function InvitationAcceptRoute(): React.ReactElement {
  return (
    <AuthBoundary>
      <AppProviders>
        <InvitationAcceptance />
      </AppProviders>
    </AuthBoundary>
  );
}

/**
 * Inner acceptance surface with access to the resolved session.
 *
 * @returns React element rendering preview, sign-up, or success states.
 */
function InvitationAcceptance(): React.ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const { isSignedIn, refreshSession } = useMeltiplyAuth();
  const scope = useSessionScope();
  const preview = useInvitationPreview(token);
  const accept = useAcceptWorkspaceInvitation(scope);
  const acceptInvitation = accept.mutate;
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const acceptStarted = useRef(false);

  const status = preview.data?.status;
  const pending = status === "pending";

  useEffect(() => {
    if (!isSignedIn || !token || !pending || acceptStarted.current) return;
    acceptStarted.current = true;
    acceptInvitation(token, {
      onError: (cause) => {
        const message =
          cause instanceof Error ? cause.message : t("The invitation could not be accepted.");
        if (message.toLowerCase().includes("verify")) {
          setNotice(t("Verify your email address, then return to this page to join."));
        } else {
          setError(message);
        }
      },
      onSuccess: async () => {
        setAccepted(true);
        await refreshSession();
      },
    });
  }, [acceptInvitation, isSignedIn, pending, refreshSession, t, token]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || !preview.data) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await authClient.signUpEmail({
        email: preview.data.email,
        invitationToken: token,
        name: name.trim(),
        password,
      });
      setPassword("");
      if (result.token) {
        await refreshSession();
        setNotice(t("Account created. Joining the workspace…"));
      } else {
        setNotice(
          t(
            "Check your email to verify your address. Membership activates automatically after verification.",
          ),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("The account could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const redirect = token
    ? `/sign-in?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`
    : "/sign-in";

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4 py-8 sm:px-8 sm:py-12">
      <section className="w-full max-w-xl space-y-6 rounded-window border border-line bg-surface p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-3 text-lg font-semibold tracking-tight text-ink">
          <BrandMark className="size-8" />
          Meltiply
        </div>

        {!token ? (
          <Alert variant="destructive">{t("This invitation link is missing its token.")}</Alert>
        ) : preview.isPending ? (
          <p role="status" className="text-sm text-ink-2">
            {t("Checking invitation…")}
          </p>
        ) : preview.error ? (
          <Alert variant="destructive">
            {t("This invitation is invalid, expired, or already used.")}
          </Alert>
        ) : (
          <>
            <div className="space-y-2">
              <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-ink-3">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                {t("Workspace invitation")}
              </span>
              <h1 className="text-2xl font-semibold tracking-tight text-ink">
                {t("Join {workspace}", { workspace: preview.data.workspace_name })}
              </h1>
              <p className="text-sm leading-relaxed text-ink-2">
                {t("You were invited as {role} for {email}.", {
                  email: preview.data.email,
                  role: roleLabel(t, preview.data.role),
                })}
              </p>
            </div>

            {!pending ? (
              <Alert variant="destructive">
                {t("This invitation is no longer pending. Ask an administrator to resend it.")}
              </Alert>
            ) : accepted ? (
              <div className="space-y-4">
                <p role="status" className="text-sm text-ink-2">
                  {t("You joined the workspace.")}
                </p>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => navigate("/posts", { replace: true })}
                >
                  {t("Open the workspace")}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ) : isSignedIn ? (
              <div className="space-y-4">
                <p role="status" className="text-sm text-ink-2">
                  {accept.isPending ? t("Joining the workspace…") : t("Accepting your invitation…")}
                </p>
                {error && <Alert variant="destructive">{error}</Alert>}
                {notice && (
                  <p role="status" className="text-sm leading-relaxed text-ink-2">
                    {notice}
                  </p>
                )}
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
                {error && <Alert variant="destructive">{error}</Alert>}
                {notice && (
                  <p role="status" className="text-sm leading-relaxed text-ink-2">
                    {notice}
                  </p>
                )}
                <div className="space-y-2">
                  <label htmlFor="invite-name" className="text-sm font-medium text-ink">
                    {t("Your name")}
                  </label>
                  <Input
                    id="invite-name"
                    autoComplete="name"
                    maxLength={100}
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={busy || Boolean(notice)}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="invite-email" className="text-sm font-medium text-ink">
                    {t("Email address")}
                  </label>
                  <Input
                    id="invite-email"
                    type="email"
                    autoComplete="username"
                    readOnly
                    value={preview.data.email}
                    aria-describedby="invite-email-help"
                  />
                  <p id="invite-email-help" className="text-xs text-ink-3">
                    {t("The invitation is locked to this email address.")}
                  </p>
                </div>
                <div className="space-y-2">
                  <label htmlFor="invite-password" className="text-sm font-medium text-ink">
                    {t("Password")}
                  </label>
                  <Input
                    id="invite-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy || Boolean(notice)}
                  />
                  <p className="text-xs text-ink-3">
                    {t("8–128 characters. Passphrases and password managers welcome.")}
                  </p>
                </div>
                <Button type="submit" className="w-full" disabled={busy || Boolean(notice)}>
                  {busy ? t("Please wait…") : t("Create account")}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 text-ink-3">
                    <MailCheck className="size-3.5" aria-hidden="true" />
                    {t("Email verification is required before joining.")}
                  </span>
                  <Link
                    className="font-medium text-ink underline-offset-4 hover:underline"
                    to={redirect}
                  >
                    {t("I already have an account")}
                  </Link>
                </div>
              </form>
            )}
          </>
        )}
      </section>
    </main>
  );
}

/**
 * Maps an invitation role to its translated label.
 *
 * @param t - Translation function from the active i18n context.
 * @param role - Invited Workspace role.
 * @returns Human-readable role label.
 */
function roleLabel(t: (message: string) => string, role: "admin" | "editor" | "viewer"): string {
  return role === "admin" ? t("Admin") : role === "editor" ? t("Editor") : t("Viewer");
}
