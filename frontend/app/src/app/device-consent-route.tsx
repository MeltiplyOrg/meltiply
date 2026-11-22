import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { can, isWorkspaceRole } from "@meltiply/domain";
import { CheckCircle2, Loader2, MonitorSmartphone, ShieldAlert, XCircle } from "lucide-react";
import { Alert } from "@meltiply/ui/alert";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { cn } from "@meltiply/ui/utils";

import { DeviceCodeSlots, DEVICE_USER_CODE_LENGTH } from "@/app/device-code-slots";
import { AppProviders } from "@/app/providers";
import { AuthBoundary } from "@/components/auth/auth-boundary";
import { useMeltiplyAuth } from "@/components/auth/auth-provider";
import { useSessionScope } from "@/hooks/use-session-scope";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  DeviceAuthorizationError,
  normalizeDeviceUserCode,
  verifyDeviceAuthorization,
} from "@/lib/device-authorization";
import type { DeviceAuthorizationReview } from "@/lib/device-authorization";
import { workspaceRoleLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useCurrentUser } from "@/lib/queries";

const DEVICE_CLIENT = "melti-cli";

type Decision = "approve" | "deny";

type Outcome = "already-approved" | "already-denied" | "approved" | "denied" | "session-mismatch";

type Phase =
  | { kind: "checking"; code: string }
  | { kind: "enter" }
  | { kind: "outcome"; outcome: Outcome }
  | { kind: "review"; review: DeviceAuthorizationReview }
  | { decision: Decision; kind: "working"; review: DeviceAuthorizationReview };

type Translate = (message: string, values?: Record<string, number | string>) => string;

type ConsentErrorAction = "session";

interface ConsentError {
  action?: ConsentErrorAction;
  message: string;
  recheck?: true;
}

function claimConsentError(t: Translate): ConsentError {
  return {
    message: t(
      "This request is bound to another account or browser session. Return to the browser session that verified it; if that session is unavailable, run melti-cli auth login again for a new code.",
    ),
  };
}

function consentErrorFor(t: Translate, cause: unknown): ConsentError {
  if (cause instanceof DeviceAuthorizationError) {
    if (cause.code === "expired_token") {
      return {
        message: t("This code has expired. Run melti-cli auth login again to get a new code."),
      };
    }
    if (cause.code === "rate_limited" || cause.status === 429) {
      return cause.retryAfterSeconds === undefined
        ? { message: t("Too many attempts. Try again in a moment.") }
        : {
            message: t("Too many attempts. Wait {seconds} seconds and try again.", {
              seconds: cause.retryAfterSeconds,
            }),
          };
    }
    if (cause.code === "unauthorized" || cause.status === 401) {
      return { action: "session", message: t("Your session ended. Sign in again to continue.") };
    }
    if (cause.code === "access_denied") {
      return claimConsentError(t);
    }
    if (cause.code === "invalid_request" || cause.code === "invalid_grant") {
      return {
        message: t(
          "That code doesn't match an active request. Check the code in your terminal and try again.",
        ),
        recheck: true,
      };
    }
  }
  if (cause instanceof TypeError) {
    return {
      message: t("We couldn't reach Meltiply. Check your connection and try again."),
    };
  }
  return { message: t("The request could not be completed. Try again.") };
}

function outcomeCopy(t: Translate, outcome: Outcome): { heading: string; intro: string } {
  switch (outcome) {
    case "approved":
      return {
        heading: t("melti-cli is approved"),
        intro: t(
          "Return to your terminal to finish signing in. melti-cli receives its own session with your current Workspace access. Signing out of the CLI will not sign out this browser.",
        ),
      };
    case "denied":
      return {
        heading: t("Access denied"),
        intro: t(
          "melti-cli was not granted access. You can close this page, or run melti-cli auth login again from your terminal.",
        ),
      };
    case "already-approved":
      return {
        heading: t("This request was already approved"),
        intro: t(
          "No further action is needed. Run melti-cli auth login if you meant to start a new request.",
        ),
      };
    case "already-denied":
      return {
        heading: t("This request was already denied"),
        intro: t("Run melti-cli auth login from your terminal to start a new request."),
      };
    case "session-mismatch":
      return {
        heading: t("This request cannot be approved here"),
        intro: claimConsentError(t).message,
      };
  }
}

function deviceReturnPath(code: string): string {
  return code ? `/device?user_code=${encodeURIComponent(code)}` : "/device";
}

export default function DeviceConsentRoute(): React.ReactElement {
  return (
    <AuthBoundary>
      <AppProviders>
        <DeviceConsentSurface />
      </AppProviders>
    </AuthBoundary>
  );
}

function DeviceConsentSurface(): React.ReactElement {
  const { isSignedIn } = useMeltiplyAuth();
  const [params] = useSearchParams();
  const [initialCode] = useState(() => normalizeDeviceUserCode(params.get("user_code") ?? ""));
  if (!isSignedIn) {
    return (
      <Navigate
        replace
        to={`/sign-in?redirect=${encodeURIComponent(deviceReturnPath(initialCode))}`}
      />
    );
  }
  return <DeviceConsent initialCode={initialCode} />;
}

function DeviceConsent({ initialCode }: { initialCode: string }): React.ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const { user } = useMeltiplyAuth();
  const scope = useSessionScope();
  const currentUser = useCurrentUser(scope);
  const [code, setCode] = useState(initialCode);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<ConsentError | null>(null);
  const [phase, setPhase] = useState<Phase>(() =>
    initialCode ? { code: initialCode, kind: "checking" } : { kind: "enter" },
  );
  const requestSequence = useRef(0);
  const autoVerified = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const settleReview = useCallback(
    (review: DeviceAuthorizationReview): boolean => {
      if (review.status === "approved" || review.status === "denied") {
        setPhase({
          kind: "outcome",
          outcome: review.status === "approved" ? "already-approved" : "already-denied",
        });
        return true;
      }
      if (review.client_id) return false;
      setPhase({ kind: "enter" });
      setError(claimConsentError(t));
      return true;
    },
    [t],
  );

  const verify = useCallback(
    async (value: string) => {
      const normalized = normalizeDeviceUserCode(value);
      if (normalized.length !== DEVICE_USER_CODE_LENGTH) {
        setPhase({ kind: "enter" });
        setError({ message: t("Enter the code shown in your terminal.") });
        return;
      }
      const request = ++requestSequence.current;
      setCode(normalized);
      setConfirmed(false);
      setError(null);
      setParams({ user_code: normalized }, { replace: true });
      setPhase({ code: normalized, kind: "checking" });
      try {
        const review = await verifyDeviceAuthorization(normalized);
        if (requestSequence.current !== request) return;
        if (!settleReview(review)) setPhase({ kind: "review", review });
      } catch (cause) {
        if (requestSequence.current !== request) return;
        setPhase({ kind: "enter" });
        setError(consentErrorFor(t, cause));
      }
    },
    [setParams, settleReview, t],
  );

  useEffect(() => {
    // StrictMode runs effects twice; the pending request is claimed once.
    if (autoVerified.current || !initialCode) return;
    autoVerified.current = true;
    void verify(initialCode);
  }, [initialCode, verify]);

  const focusKey =
    phase.kind === "checking"
      ? `checking:${phase.code}`
      : phase.kind === "review"
        ? `review:${phase.review.user_code}`
        : phase.kind === "outcome"
          ? `outcome:${phase.outcome}`
          : null;
  useEffect(() => {
    if (focusKey) headingRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  const decide = async (decision: Decision) => {
    if (phase.kind !== "review") return;
    if (decision === "approve" && (!confirmed || phase.review.client_id !== DEVICE_CLIENT)) return;
    const review = phase.review;
    const request = ++requestSequence.current;
    setError(null);
    setPhase({ decision, kind: "working", review });
    try {
      if (decision === "approve") await approveDeviceAuthorization(review.user_code);
      else await denyDeviceAuthorization(review.user_code);
      if (requestSequence.current !== request) return;
      setPhase({ kind: "outcome", outcome: decision === "approve" ? "approved" : "denied" });
    } catch (cause) {
      if (requestSequence.current !== request) return;
      if (cause instanceof DeviceAuthorizationError && cause.code === "access_denied") {
        setPhase({ kind: "outcome", outcome: "session-mismatch" });
        return;
      }
      const failure = consentErrorFor(t, cause);
      if (failure.recheck) {
        const latest = await verifyDeviceAuthorization(review.user_code).catch(() => null);
        if (requestSequence.current !== request || (latest && settleReview(latest))) return;
      }
      setPhase({ kind: "review", review });
      setError(failure);
    }
  };

  const roleValue = currentUser.data?.active_organization.role;
  const role = isWorkspaceRole(roleValue) ? roleValue : null;
  const installationOwner = currentUser.data?.is_installation_owner === true;
  const roleLabel = role ? workspaceRoleLabel(t, role) : t("Current Workspace role");
  const workspaceName = currentUser.data?.active_organization.name ?? t("Current Workspace");
  const permissions = role
    ? [
        t("Read Posts, Channels, and Analytics."),
        ...(can(role, installationOwner, "content:write") ? [t("Create and edit Posts.")] : []),
        ...(can(role, installationOwner, "content:delete-published")
          ? [t("Delete published Posts.")]
          : []),
        ...(can(role, installationOwner, "brand-profile:manage")
          ? [t("Manage Brand Profiles.")]
          : []),
        ...(can(role, installationOwner, "channel:manage")
          ? [t("Connect and manage Channels.")]
          : []),
        ...(can(role, installationOwner, "member:manage")
          ? [t("Manage Workspace members and invitations.")]
          : []),
        ...(can(role, installationOwner, "workspace:rename")
          ? [t("Change Workspace settings.")]
          : []),
        ...(can(role, installationOwner, "audit:read") ? [t("Read the Workspace audit log.")] : []),
        ...(can(role, installationOwner, "installation:manage")
          ? [t("Manage the installation.")]
          : []),
        ...(can(role, installationOwner, "member:assign-admin")
          ? [t("Assign Workspace Admins.")]
          : []),
      ]
    : [];

  const busy = phase.kind === "working";
  const workingDecision = phase.kind === "working" ? phase.decision : null;
  const review = phase.kind === "review" || phase.kind === "working" ? phase.review : null;
  const supportedClient = review?.client_id === DEVICE_CLIENT;
  const signInPath = `/sign-in?redirect=${encodeURIComponent(deviceReturnPath(code))}`;

  const { heading, intro } =
    phase.kind === "outcome"
      ? outcomeCopy(t, phase.outcome)
      : phase.kind === "checking"
        ? {
            heading: t("Checking the request…"),
            intro: t("Comparing the code with the pending request."),
          }
        : {
            heading: t("Approve melti-cli?"),
            intro:
              phase.kind === "enter"
                ? t("Enter the code shown in your terminal to review the request.")
                : t("melti-cli is asking to use your Meltiply Workspace from a terminal."),
          };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8 sm:px-8 sm:py-12 lg:py-4">
      <section
        aria-busy={busy}
        className={cn(
          "w-full overflow-hidden rounded-window border border-line bg-surface",
          review ? "max-w-4xl" : "max-w-xl",
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
          <div className="flex items-center gap-3 text-lg font-semibold tracking-tight text-ink">
            <BrandMark className="size-8" />
            Meltiply
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3">
            <MonitorSmartphone className="size-3.5" aria-hidden="true" />
            {t("Device authorization")}
          </span>
        </header>
        <div
          className={cn(
            "space-y-6 p-6 sm:p-8",
            review &&
              "lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8 lg:gap-y-5 lg:space-y-0 lg:p-5",
          )}
        >
          <div className={cn("space-y-6", review && "lg:col-span-2 lg:space-y-3")}>
            {phase.kind === "outcome" ? (
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                    phase.outcome === "approved"
                      ? "bg-green-tint text-green"
                      : phase.outcome === "denied"
                        ? "bg-red-tint text-red"
                        : "bg-canvas text-ink-3",
                  )}
                >
                  {phase.outcome === "approved" || phase.outcome === "already-approved" ? (
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                  ) : (
                    <XCircle className="size-4" aria-hidden="true" />
                  )}
                </span>
                <div className="space-y-2">
                  <h1
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-(length:--text-title) leading-8 font-semibold tracking-page-title text-ink"
                  >
                    {heading}
                  </h1>
                  <p className="text-sm leading-relaxed text-ink-2">{intro}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2.5">
                  {phase.kind === "checking" && (
                    <Loader2
                      className="size-4 shrink-0 animate-spin text-ink-3"
                      aria-hidden="true"
                    />
                  )}
                  <h1
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-(length:--text-title) leading-8 font-semibold tracking-page-title text-ink"
                  >
                    {heading}
                  </h1>
                </div>
                <p className="text-sm leading-relaxed text-ink-2">{intro}</p>
              </div>
            )}

            {error && (
              <div className="space-y-3">
                <Alert variant="destructive">{error.message}</Alert>
                {error.action === "session" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => navigate(signInPath, { replace: true })}
                  >
                    {t("Sign in again")}
                  </Button>
                )}
              </div>
            )}
          </div>

          {phase.kind === "enter" && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void verify(code);
              }}
            >
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">{t("User code")}</p>
                <DeviceCodeSlots value={code} onChange={setCode} />
                <p className="text-center text-xs text-ink-3">
                  {t("Separators and spaces are ignored. The code is not case-sensitive.")}
                </p>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={code.length !== DEVICE_USER_CODE_LENGTH}
              >
                {t("Find request")}
              </Button>
            </form>
          )}

          {review && (
            <>
              <div className="space-y-5">
                <div className="rounded-card border border-line bg-canvas px-4 py-5 text-center">
                  <p className="text-xs font-medium text-ink-3">{t("Code in your terminal")}</p>
                  <code className="mt-1.5 block break-all font-mono text-2xl font-semibold tracking-widest text-ink">
                    {review.user_code}
                  </code>
                  <p className="mt-2 text-xs leading-relaxed text-ink-3">
                    {t(
                      "Compare this with the code shown by melti-cli. Only approve if they match.",
                    )}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-3">
                    {t("This request expires ten minutes after it was created.")}
                  </p>
                </div>

                <dl className="divide-y divide-line overflow-hidden rounded-card border border-line text-sm">
                  <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                    <dt className="text-xs text-ink-3">{t("Requesting client")}</dt>
                    <dd className="min-w-0 truncate font-mono font-medium text-ink">
                      {review.client_id}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                    <dt className="text-xs text-ink-3">{t("Approving account")}</dt>
                    <dd className="min-w-0 truncate font-medium text-ink">
                      {user?.email ?? t("Current account")}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                    <dt className="text-xs text-ink-3">{t("Workspace")}</dt>
                    <dd className="min-w-0 truncate font-medium text-ink">{workspaceName}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                    <dt className="text-xs text-ink-3">{t("Workspace role")}</dt>
                    <dd className="min-w-0 truncate font-medium text-ink">{roleLabel}</dd>
                  </div>
                </dl>

                <p className="text-xs leading-relaxed text-ink-3">
                  {t(
                    "If this is not the account you meant to authorize, deny the request and run melti-cli auth login again.",
                  )}
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <h2 className="text-sm font-medium text-ink">
                    {t("Access granted to melti-cli")}
                  </h2>
                  <p className="text-xs leading-relaxed text-ink-2">
                    {t(
                      "melti-cli acts with your current Workspace permissions. It cannot do more than you can, and it never receives your password.",
                    )}
                  </p>
                  {currentUser.isPending ? (
                    <div className="space-y-2" role="status">
                      <Skeleton className="h-3.5 w-3/4" />
                      <Skeleton className="h-3.5 w-2/3" />
                      <span className="sr-only">{t("Reading Workspace access…")}</span>
                    </div>
                  ) : permissions.length > 0 ? (
                    <ul className="grid gap-x-6 gap-y-1.5 text-sm text-ink-2 sm:grid-cols-2">
                      {permissions.map((permission) => (
                        <li key={permission} className="flex items-start gap-2">
                          <CheckCircle2
                            className="mt-0.5 size-3.5 shrink-0 text-green"
                            aria-hidden="true"
                          />
                          <span>{permission}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm leading-relaxed text-ink-2">
                      {t(
                        "Your current Workspace access still applies. Detailed permissions could not be loaded.",
                      )}
                    </p>
                  )}
                </div>

                {review.client_id && !supportedClient && (
                  <Alert variant="destructive">
                    {t(
                      "This client is not supported. Deny the request and check that melti-cli is up to date.",
                    )}
                  </Alert>
                )}

                <Alert variant="warning">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <p>
                    {t(
                      "Approve only if you started melti-cli auth login on a device you control. Never approve a code someone sent you: approval gives that terminal access to your Workspace.",
                    )}
                  </p>
                </Alert>

                <p className="text-xs leading-relaxed text-ink-3">
                  {t(
                    "melti-cli is waiting in your terminal. Nothing is granted until you approve.",
                  )}
                </p>

                <label className="flex items-start gap-2.5 text-sm text-ink">
                  <Input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>{t("The code in my terminal matches this code.")}</span>
                </label>

                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="sm:flex-1"
                    disabled={busy}
                    onClick={() => {
                      void decide("deny");
                    }}
                  >
                    {workingDecision === "deny" ? t("Denying…") : t("Deny request")}
                  </Button>
                  <Button
                    type="button"
                    className="sm:flex-1"
                    disabled={busy || !confirmed || !supportedClient}
                    onClick={() => {
                      void decide("approve");
                    }}
                  >
                    {workingDecision === "approve" ? t("Approving…") : t("Approve melti-cli")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
