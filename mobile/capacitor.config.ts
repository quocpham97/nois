import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor mobile shell config — the iOS/Android counterpart of the Electron
// desktop shell (../desktop). Like that shell, the native WebView is a pure
// viewport onto the REMOTE deployed app (server.url), so the Socket.IO client,
// the session cookie, and secure-context APIs (WebCrypto, OPFS) all resolve
// against the app's own origin exactly as they do in a browser. There is no
// local Next.js build shipped in the binary.
//
// APP_URL is read at `cap sync` time (mirrors the desktop shell's APP_URL env).
// Set it to the deployed origin for a release build; leave it for the dev
// default when pointing a simulator at a local `pnpm dev` (port 4000).
const APP_URL = (process.env.APP_URL ?? "https://chat.example.com").replace(
  /\/$/,
  "",
);

const config: CapacitorConfig = {
  appId: "ae.silvertiger.messenger",
  appName: "Messenger",
  // Required to exist even though we load a remote URL: `cap copy` needs a web
  // dir. www/index.html is only a splash/fallback shown before server.url loads
  // (or if the device is offline on cold start).
  webDir: "www",
  server: {
    url: APP_URL,
    // Dev only: a localhost http origin needs cleartext. Release builds point
    // at https and this is ignored. Guarded so it is never on for prod.
    cleartext: APP_URL.startsWith("http://"),
    // Off-origin links (OAuth, external URLs) must leave the WebView for the
    // system browser — the app is exclusively a viewport onto APP_URL, matching
    // the desktop shell's will-navigate ban.
    allowNavigation: [new URL(APP_URL).hostname],
  },
  ios: {
    // Insets are handled in CSS via env(safe-area-inset-*); see globals.css.
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    // Google OAuth is blocked in embedded webviews, so login hands off to the
    // system browser (Custom Tabs) via the Browser plugin — same as desktop.
    allowMixedContent: APP_URL.startsWith("http://"),
  },
  plugins: {
    // Splash handled by the native launch screen; keep it brief.
    SplashScreen: { launchShowDuration: 0 },
    PushNotifications: {
      // presentationOptions apply when a push arrives with the app foregrounded.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
