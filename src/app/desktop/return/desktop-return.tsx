"use client";

import { useEffect, useRef, useState } from "react";

// Mints the one-time desktop code and fires the messenger:// deep link so the
// Electron app can exchange it for its own session (see api/desktop/*). The
// automatic redirect needs a manual fallback: browsers may suppress custom-
// protocol navigation that isn't tied to a user gesture.
export function DesktopReturn({ challenge }: { challenge: string }) {
  const [state, setState] = useState<"working" | "ready" | "error">("working");
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    // One code per page view (StrictMode re-runs effects in dev).
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const res = await fetch("/api/desktop/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge }),
        });
        if (!res.ok) throw new Error(`code endpoint: ${res.status}`);
        const { code } = (await res.json()) as { code: string };
        const url = `messenger://auth?code=${encodeURIComponent(code)}`;
        setAppUrl(url);
        setState("ready");
        window.location.href = url;
      } catch {
        setState("error");
      }
    })();
  }, [challenge]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg p-6 text-app-text">
      <div className="w-full max-w-sm rounded-xl border border-app-border bg-panel p-6 text-center">
        <h1 className="m-0 text-[20px] font-bold">
          {state === "error" ? "Something went wrong" : "You're signed in"}
        </h1>
        <p className="mb-5 mt-1 text-[13px] text-app-muted">
          {state === "error"
            ? "Couldn't hand the session to the app. Go back to the app and try signing in again."
            : "Returning you to the app… You can close this tab once the app opens."}
        </p>
        {appUrl && (
          <a
            href={appUrl}
            className="inline-block rounded-md border border-app-border px-4 py-2.5 text-[14px] font-medium hover:bg-panel-hover"
          >
            Open Nois
          </a>
        )}
      </div>
    </div>
  );
}
