// The entire bridge surface between the (remote, semi-trusted) web app and
// the Electron main process. Mirrors src/types/desktop.d.ts in the web repo —
// keep the two in sync. Nothing else from Node/Electron is exposed.
import { contextBridge, ipcRenderer } from "electron";

const version: string = ipcRenderer.sendSync("app:version");

contextBridge.exposeInMainWorld("desktop", {
  startLogin: () => ipcRenderer.send("auth:start-login"),
  notify: (n: { title: string; body: string; channelId: string }) =>
    ipcRenderer.send("notify", {
      title: String(n?.title ?? ""),
      body: String(n?.body ?? ""),
      channelId: String(n?.channelId ?? ""),
    }),
  onOpenChannel: (cb: (channelId: string) => void) => {
    const handler = (_e: unknown, id: unknown) => cb(String(id));
    ipcRenderer.on("open-channel", handler);
    return () => ipcRenderer.removeListener("open-channel", handler);
  },
  version,
});
