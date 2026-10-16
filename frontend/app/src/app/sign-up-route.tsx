import { AuthBoundary } from "@/components/auth/auth-boundary";
import { SignUpForm } from "@/components/auth/sign-up-form";

/**
 * Route component rendering the Better Auth sign-up form wrapped in an `AuthBoundary`.
 *
 * Provides the interactive registration entry point for new users accessing `/sign-up`.
 *
 * @returns React element rendering the centered sign-up page.
 */
export default function SignUpRoute(): React.ReactElement {
  return (
    <AuthBoundary>
      <main className="flex min-h-screen items-center justify-center bg-page px-6 py-12">
        <SignUpForm />
      </main>
    </AuthBoundary>
  );
}
