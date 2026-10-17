import { Navigate } from "react-router";

/** Redirects historical signup bookmarks to the installation-aware owner entry point. */
export default function SignUpRoute(): React.ReactElement {
  return <Navigate to="/sign-in" replace />;
}
