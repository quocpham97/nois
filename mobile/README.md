# Messenger — mobile shell (Capacitor)

iOS & Android counterpart of the Electron desktop shell (`../desktop`). Same
philosophy: a thin native WebView that loads the **remote deployed app**
(`server.url` = `APP_URL`), so the Socket.IO client, the session cookie, and
secure-context APIs (WebCrypto, OPFS) all resolve against the app's own origin —
exactly as in a browser. **No Next.js build ships inside the binary.**

Nothing here is bundled into the web app: the web repo carries zero Capacitor
dependencies. The shell logic lives web-side in `src/lib/mobile/capacitor-bridge.ts`,
runs only when `Capacitor.isNativePlatform()` is true, and installs
`window.mobile` (the same bridge contract as `window.desktop`).

## What already works vs. what's a follow-up

| Capability | Status | Where |
| --- | --- | --- |
| Load remote app, real-time messaging in foreground | ✅ | `capacitor.config.ts` |
| E2EE (MLS, WebCrypto identity keys) | ✅ if OPFS works in WebView — **see gate below** | reuses web crypto |
| Google login handoff (system browser + PKCE) | ✅ | reuses `/api/desktop/*` + `messenger://` |
| Local notifications + tap-to-open-channel | ✅ | `capacitor-bridge.ts` |
| iOS safe-area insets | ✅ | `globals.css` `.mobile` |
| **Background push (APNs/FCM)** | ⏳ follow-up | see "Push" below |
| **Message history persistence** if OPFS is unavailable | ⏳ follow-up | see "OPFS gate" |
| WebRTC calls in background | ⏳ needs CallKit/ConnectionService | see calls memo |

## Prerequisites

- Node 20+, `pnpm` (the web repo's package manager)
- **iOS**: macOS + Xcode + CocoaPods (`sudo gem install cocoapods`)
- **Android**: Android Studio + JDK 17

## First-time setup

```bash
cd mobile
pnpm install
# Generate the native projects (git-ignored by default — see .gitignore):
pnpm add:ios
pnpm add:android
```

`APP_URL` is baked into the native config at **sync** time (not runtime), same
as the desktop shell's `APP_URL`:

```bash
# Release: point at the deployed origin
APP_URL=https://chat.example.com pnpm sync

# Dev: point a simulator at your local `pnpm dev` (repo root, port 4000)
pnpm sync:local          # == APP_URL=http://localhost:4000 cap sync
```

- **iOS simulator** reaches the host's `localhost` directly.
- **Android emulator** cannot — use `APP_URL=http://10.0.2.2:4000 pnpm sync`
  (`10.0.2.2` is the emulator's alias for the host loopback). `cleartext` +
  `allowMixedContent` auto-enable for `http://` origins and stay off for https.

Then open and run from the IDE (handles signing/provisioning):

```bash
pnpm open:ios      # or: pnpm run:ios
pnpm open:android  # or: pnpm run:android
```

## Deep-link scheme (`messenger://`) — REQUIRED for login

Login reuses the desktop handoff end to end: the browser leg lands on
`/desktop/return`, mints a one-time code, and redirects to
`messenger://auth?code=…`. The OS must route that scheme back to this app. Add
it to each native project after `cap add`:

**iOS** — `ios/App/App/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>messenger</string></array>
  </dict>
</array>
```

**Android** — `android/app/src/main/AndroidManifest.xml`, inside the main
`<activity>`:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="messenger" android:host="auth" />
</intent-filter>
```

The bridge's `App.appUrlOpen` listener catches the URL, exchanges the code (the
PKCE verifier never left the WebView), and the `Set-Cookie` lands in the
WebView's own cookie jar because the exchange is same-origin with `server.url`.

## OPFS gate (validate before trusting E2EE history) ⚠️

The client message store (`src/lib/message-db.ts`) is SQLite-WASM over **OPFS
`createSyncAccessHandle`**, and identity keys are non-extractable WebCrypto
`CryptoKey`s in IndexedDB. These decide whether the app can persist decrypted
history on device:

1. **Validate first.** Run the app in each target WebView (iOS WKWebView,
   Android System WebView across a range of OS versions) and confirm messages
   persist across a cold restart. `message-db.ts` **degrades silently to an
   empty store** when Workers/OPFS are unavailable — so "no history, no error"
   is the failure signature to watch for.
2. **If OPFS is unavailable/flaky** on a target: swap the driver behind
   `message-db.ts`'s existing async API (it was deliberately built API-compatible
   with its previous IndexedDB version — "byte-for-byte the same API") for
   `@capacitor-community/sqlite` (native SQLite). Only that one module changes;
   `chat-context` and key-backup are untouched. This is the largest potential
   follow-up — scope it only if step 1 fails.

WebCrypto non-extractable keys are well-supported in both WebViews; OPFS is the
real risk.

## Push (follow-up)

Foreground messaging works over the live Socket.IO connection. Background
delivery needs native push:

1. Add APNs key (iOS) + a Firebase project / `google-services.json` +
   `GoogleService-Info.plist` (both platforms go through FCM via
   `@capacitor/push-notifications`).
2. In `capacitor-bridge.ts`, register for push, POST the device token to a new
   `/api/mobile/push-token` route, and route `pushNotificationActionPerformed`
   through the existing `emitOpenChannel()` fan-out (a stub already notes this).
3. Server: send to those tokens alongside the existing web-push subscribers
   (`src/lib/push.ts`). Keep payloads generic — the body may be an undecrypted
   E2EE envelope, exactly like `public/sw.js`.

## Keeping in sync with desktop

`window.mobile` and `window.desktop` share one contract; shared call sites go
through `src/lib/shell.ts` (`getShellBridge()`). If you extend the bridge,
update `src/types/mobile.d.ts`, `src/types/desktop.d.ts`, and both shells
together.
