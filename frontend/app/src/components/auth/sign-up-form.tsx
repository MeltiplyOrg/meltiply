import React, { useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n";

export interface SignUpFormProps {
  onSuccess?: () => void;
  redirectTo?: string;
}

/**
 * Interactive registration form allowing new creators to create an account and personal workspace.
 * Manages form state, input validation, loading indicators, and accessible theme-token error alerts.
 * On successful registration, establishes a Better Auth session that mints the
 * in-memory bearer JWT used to authorize API requests, then navigates to the workspace.
 * Consent belongs to the root first-visit prompt; this form never reopens saved choices.
 *
 * @param props Configuration options including optional redirect destination or success callback.
 * @returns An accessible sign-up form card component.
 */
export function SignUpForm({
  onSuccess,
  redirectTo = "/posts",
}: SignUpFormProps): React.ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !email.trim() || !password) {
      setError(t("Please fill out all required fields."));
      return;
    }

    if (password.length < 8) {
      setError(t("Password must be at least 8 characters long."));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await authClient.signUpEmail({
        name: name.trim(),
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
        cause instanceof Error ? cause.message : t("Registration failed. Please try again."),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-7 shadow-card sm:p-9">
      <div className="mb-6 space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {t("Create your Meltiply account")}
        </h1>
        <p className="text-sm text-ink-2">
          {t("Start scheduling and distributing your content across all platforms.")}
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
          <label htmlFor="signup-name" className="text-xs font-medium text-ink">
            {t("Your name")}
          </label>
          <Input
            id="signup-name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-1.5 text-left">
          <label htmlFor="signup-email" className="text-xs font-medium text-ink">
            {t("Email address")}
          </label>
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-1.5 text-left">
          <label htmlFor="signup-password" className="text-xs font-medium text-ink">
            {t("Password")}
          </label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <Button type="submit" variant="default" className="w-full font-medium" disabled={isLoading}>
          {isLoading ? t("Creating account...") : t("Create Account")}
        </Button>
      </form>

      <div className="mt-6 text-center text-sm text-ink-2">
        <span>{t("Already have an account?")} </span>
        <Link
          to="/sign-in"
          className="font-medium text-ink underline underline-offset-4 hover:text-ink/80"
        >
          {t("Sign in")}
        </Link>
      </div>
    </div>
  );
}
