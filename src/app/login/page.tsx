"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Lock } from "lucide-react";
import { getShellBridge } from "@/lib/shell";

// Whether we're inside a native shell — the Electron desktop shell
// (window.desktop) or the Capacitor mobile shell (window.mobile), both fixed
// for the page's lifetime and sharing the startLogin handoff. useSyncExternal
// Store gives SSR "false" and the real value on the client without a hydration
// mismatch.
const noopSubscribe = () => () => {};
const useInShell = () =>
  useSyncExternalStore(
    noopSubscribe,
    () => !!getShellBridge(),
    () => false,
  );

/** The Nois "Bubble N" mark — a message bubble with the N carved out (same
 *  path as the workspace rail logo). White bubble + gradient N, sits on the
 *  gradient tile. */
const NoisMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
    <path
      d="M19 8H41A11 11 0 0 1 52 19V31A11 11 0 0 1 41 42H25L12 53L19 42A11 11 0 0 1 8 31V19A11 11 0 0 1 19 8Z"
      fill="#fff"
    />
    <path
      d="M20 34V16L40 34V16"
      stroke="url(#nois-login-grad)"
      strokeWidth="6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <defs>
      <linearGradient
        id="nois-login-grad"
        x1="20"
        y1="16"
        x2="40"
        y2="34"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#14A3FF" />
        <stop offset="0.55" stopColor="#2E7BFF" />
        <stop offset="1" stopColor="#6A5CFF" />
      </linearGradient>
    </defs>
  </svg>
);

const GoogleG = () => (
  <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const MC_GRADIENT = "linear-gradient(140deg, #FF9D6C, #BB4E75)";

/** Static app-preview card that floats over the brand panel. Surfaces use the
 *  app tokens so it matches the comp in both themes (1a light / 1b dark). */
function PreviewCard() {
  return (
    <div className="absolute -right-12 top-[250px] animate-floaty">
      <div className="w-[352px] overflow-hidden rounded-3xl border border-white/60 bg-app-bg shadow-[0_40px_80px_-20px_rgba(20,30,80,0.55)] dark:border-app-border dark:shadow-[0_40px_90px_-20px_rgba(0,0,0,0.7)]">
        {/* header */}
        <div className="flex items-center gap-[11px] border-b border-app-border px-4 py-3.5">
          <span
            className="flex size-[38px] shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white"
            style={{ background: MC_GRADIENT }}
          >
            MC
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-bold text-app-text">Maya Chen</span>
            <span className="block text-[12px] font-medium text-app-green">Active now</span>
          </span>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--app-faint)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94m-1 7.98v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.8 12.8 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.8 12.8 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </div>
        {/* messages */}
        <div className="flex flex-col gap-[9px] bg-panel p-4">
          <div className="max-w-[76%] self-start rounded-[18px_18px_18px_5px] bg-recv-bubble px-[13px] py-[9px] text-[13.5px] leading-[1.4] text-recv-text">
            Did you see the new funnel numbers?
          </div>
          <div className="sent-grad max-w-[76%] self-end rounded-[18px_18px_5px_18px] px-[13px] py-[9px] text-[13.5px] leading-[1.4] text-white">
            Just pulled them — step 3 is way up 🎉
          </div>
          <div className="max-w-[76%] self-start rounded-[18px_18px_18px_5px] bg-recv-bubble px-[13px] py-[9px] text-[13.5px] leading-[1.4] text-recv-text">
            The onboarding revamp is working.
          </div>
          <div className="flex gap-1 self-start rounded-[18px] bg-recv-bubble px-3.5 py-3">
            {[0, 0.2, 0.4].map((delay) => (
              <span
                key={delay}
                className="size-[7px] rounded-full bg-app-faint"
                style={{ animation: `blink 1.4s infinite ${delay}s` }}
              />
            ))}
          </div>
        </div>
        {/* composer */}
        <div className="flex items-center gap-2.5 border-t border-app-border px-4 py-3">
          <span className="flex h-9 flex-1 items-center rounded-[18px] bg-panel px-3.5 text-[13px] text-app-faint">
            Message…
          </span>
          <span className="sent-grad flex size-[34px] items-center justify-center rounded-full">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Left brand panel: gradient hero (light) / radial night sky (dark) with the
 *  headline, floating preview and testimonial. Hidden below lg. */
function BrandPanel() {
  return (
    <div className="relative hidden w-[56%] max-w-[812px] shrink-0 flex-col overflow-hidden px-[60px] py-14 lg:flex [background:var(--sent-grad)] dark:[background:radial-gradient(120%_90%_at_15%_0%,#1c2b52_0%,#14141a_55%,#0e0e13_100%)]">
      {/* decorative blobs — separate light/dark treatments, per the comps */}
      <div className="absolute -top-40 -right-[120px] size-[520px] rounded-full bg-white/10 blur-[6px] dark:hidden" />
      <div className="absolute -bottom-[120px] left-[180px] size-[360px] rounded-full bg-white/[0.08] dark:hidden" />
      <div className="absolute -top-[180px] -right-40 hidden size-[560px] rounded-full dark:block dark:[background:radial-gradient(circle,rgba(46,123,255,0.35),transparent_68%)]" />
      <div className="absolute -bottom-40 left-[120px] hidden size-[420px] rounded-full dark:block dark:[background:radial-gradient(circle,rgba(106,92,255,0.28),transparent_68%)]" />

      <div className="relative flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm dark:bg-[image:var(--sent-grad)]">
          <NoisMark />
        </span>
        <span className="text-[24px] font-extrabold tracking-[-0.02em] text-white">Nois</span>
      </div>

      <div className="relative mt-[52px] max-w-[520px]">
        <h1 className="m-0 text-balance text-[46px] font-extrabold leading-[1.08] tracking-[-0.03em] text-white">
          Keep every conversation in the loop.
        </h1>
        <p className="mt-5 max-w-[440px] text-[18px] leading-normal text-white/85 dark:text-[#E4E6EB]/70">
          Fast, private messaging for the people and teams you actually want to
          keep up with.
        </p>
      </div>

      <PreviewCard />

      <div className="relative mt-auto max-w-[480px] rounded-[18px] border border-white/25 bg-white/15 p-6 backdrop-blur-md dark:border-white/10 dark:bg-white/5">
        <p className="m-0 text-[16px] font-medium leading-normal text-white dark:text-[#E4E6EB]">
          &ldquo;Nois replaced three group chats and an email thread. Our team
          actually keeps up now.&rdquo;
        </p>
        <div className="mt-4 flex items-center gap-[11px]">
          <span
            className="flex size-9 items-center justify-center rounded-full text-[13px] font-bold text-white"
            style={{ background: MC_GRADIENT }}
          >
            MC
          </span>
          <span>
            <span className="block text-[14px] font-bold text-white">Maya Chen</span>
            <span className="block text-[12.5px] text-white/75 dark:text-[#E4E6EB]/60">
              Head of Ops, Northwind
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// Three login modes sharing one page:
// - Plain browser: signIn → Google → back to "/". Unchanged behavior.
// - Inside the Electron shell (window.desktop): Google blocks OAuth in
//   embedded webviews, so the button hands off to the SYSTEM browser via the
//   preload bridge and this page just waits for the deep-link return.
// - System browser opened BY the shell (?desktop=1&challenge=…): after Google,
//   land on /desktop/return with the shell's PKCE challenge so it can mint a
//   one-time code for the app to exchange (see api/desktop/*).
function LoginCard() {
  const params = useSearchParams();
  const challenge =
    params.get("desktop") === "1" ? params.get("challenge") : null;
  const inShell = useInShell();
  const [desktopStarted, setDesktopStarted] = useState(false);

  const start = () => {
    const shell = getShellBridge();
    if (inShell && shell) {
      shell.startLogin();
      setDesktopStarted(true);
      return;
    }
    const redirectTo = challenge
      ? `/desktop/return?challenge=${encodeURIComponent(challenge)}`
      : "/";
    void signIn("google", { redirectTo });
  };

  return (
    <div className="flex min-h-screen bg-app-bg text-app-text">
      <BrandPanel />

      {/* sign-in panel */}
      <div className="flex flex-1 items-center justify-center p-8 sm:p-14">
        <div className="flex w-[380px] max-w-full flex-col">
          {/* On small screens the brand panel is hidden — show the mark here. */}
          <span className="sent-grad mb-8 flex size-10 items-center justify-center rounded-xl lg:hidden">
            <NoisMark size={22} />
          </span>

          <h2 className="m-0 text-[32px] font-extrabold tracking-[-0.02em]">
            Welcome back
          </h2>
          <p className="mb-0 mt-2.5 text-[15.5px] text-app-muted">
            {desktopStarted
              ? "Finish signing in with Google in your browser — this window will continue automatically."
              : inShell
                ? "Sign-in opens in your browser."
                : "Sign in to continue to Nois."}
          </p>

          <button
            onClick={start}
            className="mt-[34px] flex h-[54px] w-full items-center justify-center gap-3 rounded-[14px] border border-app-border bg-panel-2 text-[15.5px] font-semibold text-app-text shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:bg-panel-hover"
          >
            <GoogleG />
            {desktopStarted ? "Reopen browser sign-in" : "Continue with Google"}
          </button>

          <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-panel px-[15px] py-[13px]">
            <Lock size={18} strokeWidth={1.9} className="shrink-0 text-app-green" />
            <span className="text-[13px] leading-[1.4] text-app-muted">
              End-to-end encrypted. Your messages stay yours.
            </span>
          </div>

          <p className="mb-0 mt-8 text-[13px] leading-[1.55] text-app-faint">
            By continuing you agree to Nois&rsquo;s{" "}
            <a href="#" className="text-app-accent hover:text-app-accent-hover">
              Terms
            </a>{" "}
            and{" "}
            <a href="#" className="text-app-accent hover:text-app-accent-hover">
              Privacy Policy
            </a>
            .
          </p>
          <div className="mt-6 border-t border-app-border pt-[22px] text-[14.5px] text-app-muted">
            New to Nois?{" "}
            <button
              onClick={start}
              className="font-semibold text-app-accent hover:text-app-accent-hover"
            >
              Create an account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in a client page.
  return (
    <Suspense>
      <LoginCard />
    </Suspense>
  );
}
