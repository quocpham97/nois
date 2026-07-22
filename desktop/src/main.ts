// Electron main process: a thin shell around the remote web app. The window
// loads APP_URL (the deployed server — or localhost:4000 in dev), so the
// Socket.IO client, session cookie, and secure-context APIs (WebCrypto, OPFS)
// all resolve against the same origin they do in a browser. Remote content is
// treated as semi-trusted: contextIsolation + sandbox, a minimal preload
// bridge, origin-checked IPC, and an off-origin navigation ban.
import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  session,
  shell,
} from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleAuthUrl, startLogin } from "./auth-handoff";
import { initUpdater } from "./updater";

const APP_URL = (process.env.APP_URL ?? "https://chat.example.com").replace(/\/$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
const PROTOCOL = "messenger";

let win: BrowserWindow | null = null;

// The OPFS message store is single-instance (exclusive access handles — see
// src/lib/message-db.ts in the web repo), so a second launch must focus the
// first instead of opening a second window that would get an empty DB.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  app.setAsDefaultProtocolClient(PROTOCOL);

  app.on("second-instance", (_e, argv) => {
    if (win) {
      win.show();
      win.focus();
    }
    // Windows/Linux deliver protocol URLs via argv; macOS uses open-url.
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) void onProtocolUrl(url);
  });

  app.on("open-url", (e, url) => {
    e.preventDefault();
    void onProtocolUrl(url);
  });

  app.whenReady().then(() => {
    setupPermissions();
    createWindow();
    initUpdater();
  });

  // macOS convention: closing the window keeps the app in the dock…
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // …and clicking the dock icon brings it back.
  app.on("activate", () => {
    if (win) {
      win.show();
    } else if (app.isReady()) {
      createWindow();
    }
  });
}

// --- window ------------------------------------------------------------------

type WindowState = { x?: number; y?: number; width: number; height: number };
const stateFile = () => join(app.getPath("userData"), "window-state.json");

function loadWindowState(): WindowState {
  try {
    return { width: 1200, height: 800, ...JSON.parse(readFileSync(stateFile(), "utf8")) };
  } catch {
    return { width: 1200, height: 800 };
  }
}

function createWindow(): void {
  const state = loadWindowState();
  win = new BrowserWindow({
    ...state,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  win.on("close", () => {
    if (!win) return;
    try {
      writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
    } catch {
      // best-effort; losing window bounds is fine
    }
  });
  win.on("closed", () => {
    win = null;
  });

  // Off-origin navigation always goes to the default browser — the window is
  // exclusively a viewport onto APP_URL. (In-app Google OAuth never happens;
  // login hands off to the system browser via auth-handoff.)
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadURL(APP_URL);
}

// --- permissions ---------------------------------------------------------------

// Only the app's own origin gets mic (voice notes), notifications, and
// clipboard write; everything else is denied outright.
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "notifications",
  "clipboard-sanitized-write",
]);

function setupPermissions(): void {
  const allowed = (requestingOrigin: string, permission: string) =>
    new URL(requestingOrigin).origin === APP_ORIGIN &&
    ALLOWED_PERMISSIONS.has(permission);

  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback, details) => {
      callback(allowed(details.requestingUrl, permission));
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) => allowed(requestingOrigin, permission),
  );
}

// --- protocol / auth handoff ---------------------------------------------------

async function onProtocolUrl(url: string): Promise<void> {
  const ok = await handleAuthUrl(url, APP_URL).catch(() => false);
  if (!win) return;
  win.show();
  win.focus();
  if (ok) {
    // The exchange put a session cookie in our jar — (re)load as signed-in.
    void win.loadURL(APP_URL);
  } else {
    void win.loadURL(`${APP_URL}/login`);
  }
}

// --- IPC (origin-checked: remote content is semi-trusted) -----------------------

function fromApp(frameUrl: string | undefined): boolean {
  try {
    return !!frameUrl && new URL(frameUrl).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

ipcMain.on("auth:start-login", (e) => {
  if (!fromApp(e.senderFrame?.url)) return;
  startLogin(APP_URL);
});

ipcMain.on("app:version", (e) => {
  e.returnValue = app.getVersion();
});

// One live notification per channel: a newer message in the same channel
// replaces the previous banner instead of stacking (Electron has no `tag`).
const liveNotifications = new Map<string, Notification>();

ipcMain.on(
  "notify",
  (e, n: { title?: unknown; body?: unknown; channelId?: unknown }) => {
    if (!fromApp(e.senderFrame?.url)) return;
    if (!Notification.isSupported()) return;
    const channelId = String(n?.channelId ?? "");
    const notification = new Notification({
      title: String(n?.title ?? ""),
      body: String(n?.body ?? ""),
    });
    notification.on("click", () => {
      if (!win) createWindow();
      win?.show();
      win?.focus();
      app.focus({ steal: true });
      if (channelId) win?.webContents.send("open-channel", channelId);
    });
    liveNotifications.get(channelId)?.close();
    liveNotifications.set(channelId, notification);
    notification.show();
  },
);
