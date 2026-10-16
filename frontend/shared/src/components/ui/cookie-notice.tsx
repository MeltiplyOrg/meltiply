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

const denied: CookieConsent = {
  functional: false,
  analytics: false,
  marketing: false,
};
const accepted: CookieConsent = {
  functional: true,
  analytics: true,
  marketing: true,
};

const confirmationDurationMs = 1800;
const confirmationExitMs = 400;

/**
 * Returns a primitive JSON snapshot of the stored cookie consent so
 * `useSyncExternalStore` compares values by string identity without looping.
 *
 * @returns Serialized `CookieConsent | null` string.
 */
function consentSnapshot(): string {
  return JSON.stringify(readCookieConsent());
}

/**
 * Supplies the `"null"` SSR snapshot before hydration; the pre-paint
 * `data-cookie-decided` attribute hides the first-visit toast for returning visitors.
 *
 * @returns Literal `"null"` JSON string.
 */
function serverConsentSnapshot(): string {
  return "null";
}

/**
 * Presents the initial consent prompt and its brief confirmation on every site.
 * A valid saved decision hides all consent controls; there is no reopen action.
 * Categories remain available before a decision, and their focus handoff avoids
 * scrolling. Confirmation dismissal never moves focus to an unrelated control.
 * @param props.policyUrl - Cookie-policy destination.
 * @returns The initial consent/confirmation surface, or an empty container after a saved decision.
 */
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
  const [acceptedAny, setAcceptedAny] = useState(false);
  const [exiting, setExiting] = useState(false);
  const categoriesRef = useRef<HTMLFieldSetElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const pendingFocusRef = useRef<"categories" | "status" | null>(null);
  const visible = consent === null;
  const showToast = visible || Boolean(message);
  // Records the active surface for pre-paint consent suppression and styling.
  const toastKind = visible ? (managing ? "manage" : "prompt") : "status";

  /** Focuses initial category options when Sileo actually mounts them after its content transition. */
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

  // Categories and the confirmation receive focus after their DOM is mounted.
  // Dismissal removes only the transient surface, never focusing another control.
  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    const element = target === "status" ? viewportRef.current : categoriesRef.current;
    if (!element) return;
    pendingFocusRef.current = null;
    element.focus({ preventScroll: true });
  });

  /** Opens unchecked initial category choices without granting consent and focuses the options. */
  const manage = () => {
    setDraft(denied);
    setExiting(false);
    setManaging(true);
    setMessage("");
    pendingFocusRef.current = "categories";
  };

  /** Commits explicit choices, morphs the Sileo toast into a confirmation status, and parks focus on that region. */
  const save = (choice: CookieConsent) => {
    const hasOptional = choice.functional || choice.analytics || choice.marketing;
    setExiting(false);
    writeCookieConsent(choice);
    setManaging(false);
    setAcceptedAny(hasOptional);
    setMessage(
      hasOptional
        ? "Cookie preferences saved. Only the categories you accepted are enabled."
        : "Optional cookies rejected. Sign-in and security still work.",
    );
    pendingFocusRef.current = "status";
  };

  const title = visible
    ? managing
      ? "Cookie preferences"
      : "Your cookie choices"
    : acceptedAny
      ? "Preferences saved"
      : "Optional cookies rejected";

  const description = visible ? (
    <div data-cookie-body>
      <p data-cookie-copy>
        Essential cookies keep sign-in and security working and remember this choice. Optional
        cookies and local storage remember preferences or support analytics and marketing only if
        you accept.{" "}
        <a data-cookie-policy-link href={policyUrl}>
          Read our cookie policy
        </a>
      </p>
      {managing && (
        <fieldset data-cookie-categories ref={focusCategories} tabIndex={-1}>
          <legend data-cookie-legend>Choose optional purposes</legend>
          <label data-cookie-option data-checked={draft.functional ? "" : undefined}>
            <input
              type="checkbox"
              checked={draft.functional}
              onChange={(event) => setDraft({ ...draft, functional: event.target.checked })}
            />
            <span>
              <strong>Functional preferences</strong>
              <span>
                Remember theme, language, motion, and local work recovery. Without this, preferences
                are not remembered for later visits.
              </span>
            </span>
          </label>
          <label data-cookie-option data-checked={draft.analytics ? "" : undefined}>
            <input
              type="checkbox"
              checked={draft.analytics}
              onChange={(event) => setDraft({ ...draft, analytics: event.target.checked })}
            />
            <span>
              <strong>Analytics</strong>
              <span>
                Allow visitor measurement. No visitor analytics tracker is currently installed; your
                social-content reports are unaffected.
              </span>
            </span>
          </label>
          <label data-cookie-option data-checked={draft.marketing ? "" : undefined}>
            <input
              type="checkbox"
              checked={draft.marketing}
              onChange={(event) => setDraft({ ...draft, marketing: event.target.checked })}
            />
            <span>
              <strong>Marketing</strong>
              <span>
                Allow advertising and campaign attribution. No marketing tracker is currently
                installed.
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
          Accept all
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
            state={visible ? "action" : acceptedAny ? "success" : "info"}
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
