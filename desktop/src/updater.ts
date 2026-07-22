// Auto-update from GitHub Releases (feed configured via electron-builder's
// `publish`). macOS requires the app to be signed and shipped as `zip` for
// differential updates to apply.
import { app } from "electron";
import { autoUpdater } from "electron-updater";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function initUpdater(): void {
  if (!app.isPackaged) return; // dev runs have no update feed
  const check = () => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      console.warn("[updater] check failed:", (e as Error).message);
    });
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
