import { useSearchParams } from "react-router";

import { AuthBoundary } from "@/components/auth/auth-boundary";
import { SignInForm } from "@/components/auth/sign-in-form";
import { sameOriginPath } from "@/lib/navigation";

export default function SignInRoute(): React.ReactElement {
  const [params] = useSearchParams();
  const redirectTo = sameOriginPath(params.get("redirect")) ?? "/posts";
  return (
    <AuthBoundary>
      <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8 sm:px-8 sm:py-12">
        <SignInForm redirectTo={redirectTo} />
      </main>
    </AuthBoundary>
  );
}
