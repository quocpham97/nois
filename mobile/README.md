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
| Background push (APNs/FCM) | ✅ code done, needs credentials | `capacitor-bridge.ts` + `src/server/mobile-push.ts`; see "Push" below |
| App icon badge (unread count) | ✅ | `@capawesome/capacitor-badge` via `setBadge` in `capacitor-bridge.ts` |
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

## Media permissions — REQUIRED for voice messages and calls

`getUserMedia` is denied outright without these, so the mic button and every
call (see `docs/calls.md`) fail in the shell no matter what the web app does.
The native projects are generated and gitignored, so — like the deep-link
scheme below — this has to be re-applied after `cap add`.

**iOS** — `ios/App/App/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access is used for voice messages and calls.</string>
<key>NSCameraUsageDescription</key>
<string>Camera access is used for video calls.</string>
```

**Android** — `android/app/src/main/AndroidManifest.xml`, above `<application>`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

Capacitor's bridge answers the WebView's permission request and triggers the
runtime prompt. Neither platform has been exercised on a device yet.

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

## Push

Foreground messaging rides the live Socket.IO connection; the page raises its own
banner for a message that arrives while it is backgrounded (`src/lib/notify.ts`).
Background delivery — app closed, no socket — is native push, and the code for it
is in place:

- **Device registration**: `capacitor-bridge.ts` asks for permission from the
  settings toggle (`window.mobile.setPushEnabled`, which `src/lib/push.ts` calls
  in place of Web Push in a shell), then `register()`. The `registration`
  listener POSTs the token to `/api/mobile/push-token` with its platform, and
  re-registers on every launch, because tokens rotate while the app is closed.
- **Taps**: `pushNotificationActionPerformed` → `emitOpenChannel()`, the same
  fan-out a tapped local notification uses. There is deliberately no
  `pushNotificationReceived` handler: a push that lands with the app open
  duplicates what the socket already delivered.
- **Calls too**: `call:start` pushes members it can't ring over the wire, and the
  app learns about the live call on connect so the ring is answerable. It arrives
  as a normal alert, not a system call screen — CallKit/ConnectionService and a
  VoIP push type would be the next step there.
- **Sending**: `src/server/mobile-push.ts`, called from `maybePush` in server.ts
  beside the Web Push fanout, under the same preferences (mute, quiet hours,
  level) and the same 30s per-conversation coalescing. Payloads are generic —
  "New message from Alice" — because the server cannot read the message.

### What is still needed: credentials

The transports are chosen per token, so each platform can be enabled alone.

**Android (FCM).** Create a Firebase project, add the Android app, drop
`google-services.json` into `android/app/`, then create a service account with
the *Firebase Cloud Messaging API* scope and set on the server:

```
FCM_PROJECT_ID=your-project-id
FCM_CLIENT_EMAIL=svc@your-project.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**iOS (APNs).** In the Apple developer portal: enable Push Notifications on the
App ID, add the *Push Notifications* capability in Xcode, and create an APNs
Auth Key (p8). Then:

```
APNS_KEY_ID=ABCD123456
APNS_TEAM_ID=TEAM123456
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
APNS_BUNDLE_ID=ae.silvertiger.messenger   # = appId in capacitor.config.ts
APNS_HOST=api.sandbox.push.apple.com      # debug/TestFlight builds only
```

`@capacitor/push-notifications` registers a raw APNs token on iOS, which is why
the server talks to APNs directly. If you would rather route iOS through
Firebase too, add the Firebase iOS SDK plus `GoogleService-Info.plist` and the
device will register an FCM token — no server change needed, since no "ios" rows
will exist.

Run `pnpm sync` after adding either platform file.

## Keeping in sync with desktop

`window.mobile` and `window.desktop` share one contract; shared call sites go
through `src/lib/shell.ts` (`getShellBridge()`). If you extend the bridge,
update `src/types/mobile.d.ts`, `src/types/desktop.d.ts`, and both shells
together.
