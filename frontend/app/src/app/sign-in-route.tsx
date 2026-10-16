import { AuthBoundary } from "@/components/auth/auth-boundary";
import { SignInForm } from "@/components/auth/sign-in-form";

/**
 * Route component rendering the Better Auth sign-in form wrapped in an `AuthBoundary`.
 *
 * Provides the interactive login entry point for unauthenticated users accessing `/sign-in`.
 *
 * @returns React element rendering the centered sign-in page.
 */
export default function SignInRoute(): React.ReactElement {
  return (
    <AuthBoundary>
      <main className="flex min-h-screen items-center justify-center bg-page px-6 py-12">
        <SignInForm />
      </main>
    </AuthBoundary>
  );
}
