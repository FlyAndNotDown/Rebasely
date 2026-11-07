const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

export interface GoogleTag {
  ready: Promise<void>;
  send(name: string, parameters?: Record<string, unknown>): void;
  disable(): void;
}

export function createGoogleTag(host: Window, measurementId: string | undefined, configuration: Record<string, unknown>): GoogleTag {
  if (!measurementId || !MEASUREMENT_ID.test(measurementId)) throw new Error("Analytics is unavailable.");
  const globals = host as unknown as Record<string, unknown>;
  const disableKey = `ga-disable-${measurementId}`;
  const layer: unknown[] = [];
  let disabled = false;
  let timeout: number | undefined;
  let rejectLoad: ((error: Error) => void) | undefined;
  const script = host.document.createElement("script");
  globals[disableKey] = false;
  globals.dataLayer = layer;
  function gtag(..._parameters: unknown[]) {
    // Google tag commands require the canonical Arguments object, not an Array.
    // eslint-disable-next-line prefer-rest-params -- Preserve the official gtag.js command protocol.
    if (!disabled) layer.push(arguments);
  }
  globals.gtag = gtag;
  gtag("consent", "default", {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
    analytics_storage: "granted",
  });
  gtag("js", new Date());
  gtag("config", measurementId, configuration);
  const ready = new Promise<void>((resolve, reject) => {
    rejectLoad = reject;
    script.onload = () => {
      if (timeout !== undefined) host.clearTimeout(timeout);
      if (!disabled) resolve();
    };
    script.onerror = () => reject(new Error("Analytics is unavailable."));
    timeout = host.setTimeout(() => reject(new Error("Analytics is unavailable.")), 10_000);
  });
  script.async = true;
  script.referrerPolicy = "no-referrer";
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  host.document.head.appendChild(script);
  return {
    ready,
    send(name, parameters = {}) {
      if (!disabled) gtag("event", name, { ...parameters, send_to: measurementId });
    },
    disable() {
      if (disabled) return;
      disabled = true;
      // Google checks this flag before cookies or collection, including unload.
      globals[disableKey] = true;
      layer.length = 0;
      if (timeout !== undefined) host.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      script.remove();
      rejectLoad?.(new Error("Analytics is disabled."));
    },
  };
}
