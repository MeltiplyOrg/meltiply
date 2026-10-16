import React, { useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n";

export interface SignInFormProps {
  onSuccess?: () => void;
  redirectTo?: string;
}

/**
 * Interactive authentication form allowing creators to sign into Meltiply using Better Auth.
 * Manages form state, input validation, loading indicators, and accessible theme-token error alerts.
 * On successful authentication, the Better Auth lifecycle mints the in-memory
 * bearer JWT used to authorize API requests, then navigates to the workspace.
 * Consent belongs to the root first-visit prompt; this form never reopens saved choices.
 *
 * @param props Configuration options including optional redirect destination or success callback.
 * @returns An accessible sign-in form card component.
 */
export function SignInForm({
  onSuccess,
  redirectTo = "/posts",
}: SignInFormProps): React.ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError(t("Please provide both email and password."));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await authClient.signInEmail({
        email: email.trim(),
        password,
      });
      if (onSuccess) {
        onSuccess();
      } else {
        navigate(redirectTo);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("Authentication failed. Please try again."),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-7 shadow-card sm:p-9">
      <div className="mb-6 space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {t("Sign in to Meltiply")}
        </h1>
        <p className="text-sm text-ink-2">
          {t("Welcome back! Enter your details to access your workspace.")}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red/20 bg-red-tint p-3 text-sm text-red"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5 text-left">
          <label htmlFor="signin-email" className="text-xs font-medium text-ink">
            {t("Email address")}
          </label>
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-1.5 text-left">
          <label htmlFor="signin-password" className="text-xs font-medium text-ink">
            {t("Password")}
          </label>
          <Input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <Button type="submit" variant="default" className="w-full font-medium" disabled={isLoading}>
          {isLoading ? t("Signing in...") : t("Sign In")}
        </Button>
      </form>

      <div className="mt-6 text-center text-sm text-ink-2">
        <span>{t("Don't have an account?")} </span>
        <Link
          to="/sign-up"
          className="font-medium text-ink underline underline-offset-4 hover:text-ink/80"
        >
          {t("Sign up")}
        </Link>
      </div>
    </div>
  );
}
