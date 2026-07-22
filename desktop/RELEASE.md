# Desktop release checklist

The macOS Electron shell in `desktop/` builds and runs today. This file tracks
the steps still required for a **signed, notarized, auto-updating** public
release. Config lives in `electron-builder.yml`.

Status legend: ✅ done · ⬜ needs your account/decision

---

## Build scripts (in `package.json`)

| Script            | What it does                                        | Works now? |
| ----------------- | --------------------------------------------------- | ---------- |
| `npm run pack`    | Unsigned `--dir` build, no notarization             | ✅ yes      |
| `npm run dist`    | Full build, `--publish never` (needs cert + icon)   | ⬜          |
| `npm run release` | Full build, `--publish always` (needs cert + repo)  | ⬜          |

---

## ⬜ 1. GitHub repo (for auto-update publishing)

The project has **no git repo yet**, and `publish.owner` / `publish.repo` in
`electron-builder.yml` are `FILL_ME_*` sentinels. `electron-updater` pulls
releases from GitHub Releases, so this must be a real repo before `npm run
release`.

When ready:

```sh
cd /Users/chris/Code/chat-app
git init && git add . && git commit -m "Initial commit"
gh repo create <owner>/<repo> --private --source=. --push
```

Then set in `electron-builder.yml`:

```yaml
publish:
  provider: github
  owner: <owner>          # e.g. silvertiger
  repo: <repo>            # e.g. messenger-desktop
```

Publishing also needs a `GH_TOKEN` env var (a GitHub PAT with `repo` scope) at
`npm run release` time.

---

## ⬜ 2. Apple Developer ID signing + notarization

No Apple Developer account / cert yet. `electron-builder.yml` already has
`hardenedRuntime: true`, `notarize: true`, and the entitlements wired up — it
just needs credentials at build time.

When ready:

1. Enroll in the Apple Developer Program; create a **Developer ID Application**
   certificate and install it in the login keychain (electron-builder
   auto-discovers it).
2. Create an app-specific password at appleid.apple.com.
3. Export before `npm run dist` / `npm run release`:

   ```sh
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"        # 10-char team ID
   ```

Until then, use `npm run pack` (sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and
disables notarize) for local unsigned testing.

---

## ⬜ 3. App icon

`build/icon.icns` is missing. From a 1024×1024 PNG:

```sh
mkdir icon.iconset
sips -z 16 16   icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32   icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32   icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64   icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128 icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256 icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
cp icon.png icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o build/icon.icns
```

---

## ✅ Already configured

- `appId: ae.silvertiger.chat` — **never change once shipped** (auto-update and
  code-signing identity are keyed to it).
- `mac.target`: universal `dmg` + `zip` (zip is required by electron-updater).
- Hardened runtime + entitlements (`build/entitlements.mac.plist`).
- `messenger://` URL scheme for the PKCE login deep link.
- Microphone usage description (voice notes).
