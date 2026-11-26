import { Cookie } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  readCookieConsent,
  subscribeCookieConsent,
  writeCookieConsent,
  type CookieConsent,
} from "../../../cookie-consent";
import "../../../cookie-notice.css";
import { Sileo } from "./sileo";

const denied: CookieConsent = { functional: false };
const accepted: CookieConsent = { functional: true };

const confirmationDurationMs = 1800;
const confirmationExitMs = 400;

function consentSnapshot(): string {
  return JSON.stringify(readCookieConsent());
}

function serverConsentSnapshot(): string {
  return "null";
}

export function CookieNotice({
  policyUrl = "https://meltiply.com/docs/cookies",
}: {
  policyUrl?: string;
}) {
  const snapshot = useSyncExternalStore(
    subscribeCookieConsent,
    consentSnapshot,
    serverConsentSnapshot,
  );
  const consent: CookieConsent | null = JSON.parse(snapshot);
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<CookieConsent>(denied);
  const [message, setMessage] = useState("");
  const [acceptedOptional, setAcceptedOptional] = useState(false);
  const [exiting, setExiting] = useState(false);
  const categoriesRef = useRef<HTMLFieldSetElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const pendingFocusRef = useRef<"categories" | "status" | null>(null);
  const visible = consent === null;
  const showToast = visible || Boolean(message);
  const toastKind = visible ? (managing ? "manage" : "prompt") : "status";

  const focusCategories = useCallback((element: HTMLFieldSetElement | null) => {
    categoriesRef.current = element;
    if (element && pendingFocusRef.current === "categories") {
      pendingFocusRef.current = null;
      element.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    if (!message) return;
    const exitTimer = window.setTimeout(() => setExiting(true), confirmationDurationMs);
    const timer = window.setTimeout(() => {
      setMessage("");
      setExiting(false);
    }, confirmationDurationMs + confirmationExitMs);
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(timer);
    };
  }, [message]);

  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    const element = target === "status" ? viewportRef.current : categoriesRef.current;
    if (!element) return;
    pendingFocusRef.current = null;
    element.focus({ preventScroll: true });
  });

  const manage = () => {
    setDraft(denied);
    setExiting(false);
    setManaging(true);
    setMessage("");
    pendingFocusRef.current = "categories";
  };

  const save = (choice: CookieConsent) => {
    setExiting(false);
    writeCookieConsent(choice);
    setManaging(false);
    setAcceptedOptional(choice.functional);
    setMessage(
      choice.functional
        ? "Cookie preferences saved. Functional preferences are enabled."
        : "Optional cookies rejected. Sign-in and security still work.",
    );
    pendingFocusRef.current = "status";
  };

  const title = visible
    ? managing
      ? "Cookie preferences"
      : "Your cookie choices"
    : acceptedOptional
      ? "Preferences saved"
      : "Optional cookies rejected";

  const description = visible ? (
    <div data-cookie-body>
      <p data-cookie-copy>
        Essential cookies keep sign-in and security working and remember this choice. Optional local
        storage remembers your theme, language, and in-progress work only if you allow it.{" "}
        <a data-cookie-policy-link href={policyUrl}>
          Read our cookie policy
        </a>
      </p>
      {managing && (
        <fieldset data-cookie-categories ref={focusCategories} tabIndex={-1}>
          <legend data-cookie-legend>Optional purpose</legend>
          <label data-cookie-option data-checked={draft.functional ? "" : undefined}>
            <input
              type="checkbox"
              checked={draft.functional}
              onChange={(event) => setDraft({ ...draft, functional: event.target.checked })}
            />
            <span>
              <strong>Functional preferences</strong>
              <span>
                Remember theme, language, and local work recovery. Without this, preferences are not
                remembered for later visits.
              </span>
            </span>
          </label>
        </fieldset>
      )}
      <div data-cookie-actions>
        <button type="button" data-cookie-btn="secondary" onClick={() => save(denied)}>
          Reject optional
        </button>
        <button type="button" data-cookie-btn="primary" onClick={() => save(accepted)}>
          Allow functional
        </button>
        {managing ? (
          <button type="button" data-cookie-btn="manage" onClick={() => save(draft)}>
            Save preferences
          </button>
        ) : (
          <button type="button" data-cookie-btn="manage" onClick={manage}>
            Manage preferences
          </button>
        )}
      </div>
    </div>
  ) : (
    <p data-cookie-status-copy>{message}</p>
  );

  return (
    <div data-cookie-controls data-cookie-toast={showToast ? toastKind : undefined}>
      {showToast && (
        <section ref={viewportRef} data-sileo-viewport data-position="bottom-right" tabIndex={-1}>
          <Sileo
            id="cookie-consent"
            width={368}
            position="right"
            expand="top"
            exiting={exiting}
            pinned={visible}
            firstVisitMarker={!managing && visible}
            role={visible ? "region" : "status"}
            ariaLabel={visible ? title : undefined}
            state={visible ? "action" : acceptedOptional ? "success" : "info"}
            icon={visible ? <Cookie className="size-3.5" aria-hidden="true" /> : undefined}
            title={title}
            description={description}
            autoExpandDelayMs={0}
            refreshKey={visible ? (managing ? "manage" : "prompt") : message}
          />
        </section>
      )}
    </div>
  );
}
