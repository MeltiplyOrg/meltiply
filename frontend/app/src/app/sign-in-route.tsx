import { useSearchParams } from "react-router";

import { AuthBoundary } from "@/components/auth/auth-boundary";
import { SignInForm } from "@/components/auth/sign-in-form";

/**
 * Route component rendering the Better Auth sign-in form wrapped in an `AuthBoundary`.
 *
 * A `redirect` query parameter lets invitation links return the visitor to the
 * acceptance page after sign-in; only same-origin paths are accepted so the
 * parameter cannot become an open redirect.
 *
 * @returns React element rendering the centered sign-in page.
 */
export default function SignInRoute(): React.ReactElement {
  const [params] = useSearchParams();
  const requested = params.get("redirect");
  const redirectTo =
    requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/posts";
  return (
    <AuthBoundary>
      <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8 sm:px-8 sm:py-12">
        <SignInForm redirectTo={redirectTo} />
      </main>
    </AuthBoundary>
  );
}
