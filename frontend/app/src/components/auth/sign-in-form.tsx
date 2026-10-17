import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Alert } from "@meltiply/ui/alert";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n";

export interface SignInFormProps {
  onSuccess?: () => void;
  redirectTo?: string;
}

type Mode = "loading" | "unavailable" | "setup" | "signin" | "recovery" | "reset" | "factor";

/**
 * Coordinates installation-aware owner setup, sign-in, and recovery state.
 * Server status selects setup; it never grants signup authority. Passwords and
 * setup/challenge secrets stay in component memory and support paste/autofill.
 * Deployed signup waits for email verification instead of claiming a session.
 * Async errors preserve inputs, announce recovery, and never expose account data.
 */
function useOwnerEntry({ onSuccess, redirectTo = "/posts" }: SignInFormProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [resetToken] = useState(() => params.get("token"));
  const [linkError] = useState(() => params.has("error"));
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [setupSecret, setSetupSecret] = useState("");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    params.has("verified") && !linkError ? t("Email verified. Sign in to continue.") : null,
  );
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    authClient
      .setupStatus()
      .then((status) => {
        if (!cancelled) {
          setMode(!status.initialized ? "setup" : resetToken ? "reset" : "signin");
          setError(
            linkError
              ? "This link is invalid or expired. Request a new verification or password reset link."
              : null,
          );
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setMode("unavailable");
          setError(cause instanceof Error ? cause.message : "Could not check installation status.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, resetToken, linkError]);

  useEffect(() => {
    // Remove recovery credentials from browser history immediately, not on submit.
    if (params.has("token")) setParams({}, { replace: true });
  }, [params, setParams]);

  const complete = () => {
    if (onSuccess) onSuccess();
    else navigate(redirectTo, { replace: true });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "setup") {
        const result = await authClient.signUpEmail({
          name: name.trim(),
          email: email.trim(),
          password,
          setupSecret,
        });
        setSetupSecret("");
        setPassword("");
        if (result.token) complete();
        else {
          setMode("signin");
          setNotice(
            t("Owner account created. Check your email to verify your address, then sign in."),
          );
        }
      } else if (mode === "recovery") {
        await authClient.requestPasswordReset({ email: email.trim() });
        setNotice(
          t("If this address belongs to the owner, a password reset link will arrive by email."),
        );
      } else if (mode === "reset" && resetToken) {
        await authClient.resetPassword({ token: resetToken, newPassword: password });
        setPassword("");
        setMode("signin");
        setNotice(t("Password updated. Sign in again with your new password."));
      } else if (mode === "factor") {
        await authClient.verifySecondFactor(code.trim(), backup);
        setCode("");
        complete();
      } else {
        const result = await authClient.signInEmail({ email: email.trim(), password });
        setPassword("");
        if (result.twoFactorRedirect) setMode("factor");
        else complete();
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("Authentication failed. Please try again."),
      );
      if (mode === "setup") {
        try {
          if ((await authClient.setupStatus()).initialized) {
            setMode("signin");
            setSetupSecret("");
            setPassword("");
            setNotice(
              t(
                "This installation now has an owner. Sign in, or resend verification if this is your account.",
              ),
            );
          }
        } catch {
          // Preserve the original signup failure when readiness is also unavailable.
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!email.trim()) {
      setError(t("Enter your email address first."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authClient.resendVerification(email.trim());
      setNotice(t("If verification is needed, a new link will arrive by email."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not send a verification link."));
    } finally {
      setBusy(false);
    }
  };

  const heading =
    mode === "setup"
      ? t("Make this workspace yours.")
      : mode === "recovery"
        ? t("Recover your access.")
        : mode === "reset"
          ? t("Choose a new password.")
          : mode === "factor"
            ? t("One more security check.")
            : t("Welcome back.");
  return {
    mode,
    setMode,
    email,
    setEmail,
    name,
    setName,
    password,
    setPassword,
    setupSecret,
    setSetupSecret,
    code,
    setCode,
    backup,
    setBackup,
    error,
    setError,
    notice,
    setNotice,
    busy,
    setAttempt,
    heading,
    submit,
    resend,
  };
}

/**
 * Renders the responsive owner-access surface from the private lifecycle hook.
 * Shared controls own focus/disabled states; the page adds no decorative motion.
 * Input state survives recoverable errors, and only server status exposes setup.
 */
export function SignInForm(props: SignInFormProps): React.ReactElement {
  const { t } = useI18n();
  const {
    mode,
    setMode,
    email,
    setEmail,
    name,
    setName,
    password,
    setPassword,
    setupSecret,
    setSetupSecret,
    code,
    setCode,
    backup,
    setBackup,
    error,
    setError,
    notice,
    setNotice,
    busy,
    setAttempt,
    heading,
    submit,
    resend,
  } = useOwnerEntry(props);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (mode !== "loading") headingRef.current?.focus({ preventScroll: true });
  }, [mode]);

  return (
    <section className="grid w-full max-w-5xl overflow-hidden rounded-window border border-line bg-surface shadow-card lg:grid-cols-[0.95fr_1fr]">
      <aside className="flex flex-col justify-between gap-6 border-b border-line bg-inset p-6 sm:p-8 lg:gap-12 lg:border-r lg:border-b-0 lg:p-12">
        <div className="flex items-center gap-3 text-lg font-semibold tracking-tight text-ink">
          <BrandMark className="size-8" />
          Meltiply
        </div>
        <div className="hidden max-w-sm space-y-5 lg:block">
          <p className="text-xs font-medium uppercase tracking-widest text-ink-3">
            {t("Your private publishing workspace")}
          </p>
          <p className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            {t("One place to shape what’s next.")}
          </p>
          <p className="text-sm leading-relaxed text-ink-2">
            {t("Compose your posts, connect your channels, and publish on your terms.")}
          </p>
        </div>
        <div className="hidden items-start gap-3 border-t border-line pt-6 text-xs leading-relaxed text-ink-2 lg:flex">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            {t("Self-hosted. Single owner. Your account is the only way into this installation.")}
          </p>
        </div>
      </aside>
      <div className="flex flex-col justify-center p-6 sm:p-8 lg:p-12">
        <div className="mb-8 space-y-3">
          <span className="inline-flex items-center gap-2 text-xs font-medium text-ink-3">
            <KeyRound className="size-3.5" aria-hidden="true" />
            {mode === "setup" ? t("INITIAL SETUP") : t("OWNER ACCESS")}
          </span>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-3xl font-semibold tracking-tight text-ink"
          >
            {heading}
          </h1>
          <p className="text-sm leading-relaxed text-ink-2">
            {mode === "setup"
              ? t(
                  "Create the only account for this installation. You’ll need the setup secret from your deployment configuration.",
                )
              : mode === "factor"
                ? t("Enter a code from your authenticator, or use a saved backup code.")
                : mode === "recovery"
                  ? t("We’ll send a reset link to the owner’s email address.")
                  : mode === "reset"
                    ? t(
                        "Use a unique password or a long passphrase. All previous sessions will be signed out.",
                      )
                    : t("Sign in with the owner account to continue to your workspace.")}
          </p>
        </div>
        {error && (
          <Alert id="auth-error" variant="destructive" className="mb-5">
            {t(error)}
          </Alert>
        )}
        {notice && (
          <p role="status" className="mb-5 text-sm leading-relaxed text-ink-2">
            {notice}
          </p>
        )}
        {mode === "loading" ? (
          <p role="status" className="text-sm text-ink-2">
            {t("Checking installation…")}
          </p>
        ) : mode === "unavailable" ? (
          <Button
            onClick={() => {
              setMode("loading");
              setAttempt((value) => value + 1);
            }}
          >
            {t("Try again")}
          </Button>
        ) : (
          <form
            onSubmit={submit}
            className="space-y-5"
            aria-busy={busy}
            aria-describedby={error ? "auth-error" : undefined}
          >
            {mode === "setup" && (
              <div className="space-y-2">
                <label htmlFor="auth-name" className="text-sm font-medium text-ink">
                  {t("Your name")}
                </label>
                <Input
                  id="auth-name"
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </div>
            )}
            {(mode === "setup" || mode === "signin" || mode === "recovery") && (
              <div className="space-y-2">
                <label htmlFor="auth-email" className="text-sm font-medium text-ink">
                  {t("Email address")}
                </label>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                />
              </div>
            )}
            {(mode === "setup" || mode === "signin" || mode === "reset") && (
              <div className="space-y-2">
                <label htmlFor="auth-password" className="text-sm font-medium text-ink">
                  {t("Password")}
                </label>
                <Input
                  id="auth-password"
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  minLength={mode === "signin" ? undefined : 8}
                  maxLength={128}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
                {mode !== "signin" && (
                  <p className="text-xs text-ink-3">
                    {t("8–128 characters. Passphrases and password managers welcome.")}
                  </p>
                )}
              </div>
            )}
            {mode === "setup" && (
              <div className="space-y-2">
                <label htmlFor="auth-setup" className="text-sm font-medium text-ink">
                  {t("Setup secret")}
                </label>
                <Input
                  id="auth-setup"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={32}
                  value={setupSecret}
                  onChange={(event) => setSetupSecret(event.target.value)}
                  disabled={busy}
                  aria-describedby="setup-help"
                />
                <p id="setup-help" className="text-xs leading-relaxed text-ink-3">
                  {t(
                    "Use AUTH_SETUP_SECRET from your private deployment environment. It is not your account password.",
                  )}
                </p>
              </div>
            )}
            {mode === "factor" && (
              <div className="space-y-2">
                <label htmlFor="auth-code" className="text-sm font-medium text-ink">
                  {backup ? t("Backup code") : t("Authenticator code")}
                </label>
                <Input
                  id="auth-code"
                  autoComplete="one-time-code"
                  inputMode={backup ? "text" : "numeric"}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={busy}
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy
                ? t("Please wait…")
                : mode === "setup"
                  ? t("Create owner account")
                  : mode === "recovery"
                    ? t("Send reset link")
                    : mode === "reset"
                      ? t("Update password")
                      : mode === "factor"
                        ? t("Verify and sign in")
                        : t("Sign in")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
            {mode === "signin" && (
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  disabled={busy}
                  onClick={() => {
                    setMode("recovery");
                    setError(null);
                    setNotice(null);
                  }}
                >
                  {t("Forgot password?")}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  disabled={busy}
                  onClick={resend}
                >
                  {t("Resend verification")}
                </Button>
              </div>
            )}
            {mode === "factor" && (
              <Button
                type="button"
                variant="link"
                disabled={busy}
                onClick={() => {
                  setBackup(!backup);
                  setCode("");
                  setError(null);
                }}
              >
                {backup ? t("Use authenticator instead") : t("Use a backup code")}
              </Button>
            )}
            {(mode === "recovery" || mode === "factor" || mode === "reset") && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={busy}
                onClick={() => {
                  setMode("signin");
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
              >
                {t("Back to sign in")}
              </Button>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
