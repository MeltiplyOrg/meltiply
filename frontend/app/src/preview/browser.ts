import { setupWorker } from "msw/browser";
import { createPreviewHandlers } from "./handlers";
import { activePreviewOptions } from "./scenarios";

/** Installs fixture interception before router creation. Startup failures reject bootstrap; API misses cannot bypass to a server. */
export async function startPreview(): Promise<void> {
  const worker = setupWorker(...createPreviewHandlers(activePreviewOptions));
  await worker.start({
    quiet: true,
    serviceWorker: { url: "/mockServiceWorker.js" },
    onUnhandledRequest(request, print) {
      const url = new URL(request.url);
      if (url.origin !== window.location.origin || /^\/api(?:\/|$)/.test(url.pathname))
        print.error();
    },
  });
}
