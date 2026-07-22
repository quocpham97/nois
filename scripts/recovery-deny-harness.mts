// Drives a FRESH device for an existing user: publishes a real key bundle to
// the directory and emits a `recovery:request`, then waits to see whether a
// `recovery:offer` comes back. Used to test the device-approval DENY path in a
// real browser: run this, then click Deny on the modal that pops in the other
// (existing) device — this client should receive NO offer.
//
// Run: npx tsx --env-file=.env.local scripts/recovery-deny-harness.mts <uid>

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";

const URL = "http://localhost:4000";
const UID = process.argv[2] || "wuewue17@gmail.com";
const WAIT_MS = 25000;

const ID_CURVE = { name: "ECDSA", namedCurve: "P-256" } as const;
const ID_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const ECDH_CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

const toB64 = (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString("base64");

// Same 30-digit grouped safety number the app derives (identity.ts).
async function fingerprintFromSpki(spki: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
  let out = "";
  for (let i = 0; i < 15; i++) out += (d[i] % 100).toString().padStart(2, "0");
  return out.match(/.{1,5}/g)!.join(" ");
}

async function mintCookie(uid: string): Promise<string> {
  const jwt = await encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  return `authjs.session-token=${jwt}`;
}

async function main() {
  // Build a real fresh device identity + bundle.
  const identity = (await crypto.subtle.generateKey(ID_CURVE, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = await crypto.subtle.exportKey("spki", identity.publicKey);
  const identityKey = toB64(spki);
  const fingerprint = await fingerprintFromSpki(spki);
  const deviceId = crypto.randomUUID();

  const spk = (await crypto.subtle.generateKey(ECDH_CURVE, true, ["deriveBits"])) as CryptoKeyPair;
  const spkRaw = await crypto.subtle.exportKey("raw", spk.publicKey);
  const spkSig = await crypto.subtle.sign(ID_SIGN, identity.privateKey, spkRaw);
  const signedPreKey = { id: crypto.randomUUID(), pub: toB64(spkRaw), sig: toB64(spkSig) };

  const bundle = { userId: UID, deviceId, identityKey, signedPreKey, oneTimePreKeys: [] };

  const cookie = await mintCookie(UID);
  const s: Socket = io(URL, { transports: ["websocket"], extraHeaders: { cookie }, forceNew: true });
  await new Promise<void>((res, rej) => {
    s.on("connect", () => res());
    s.on("connect_error", (e) => rej(e));
    setTimeout(() => rej(new Error("connect timeout")), 6000);
  });

  let offerReceived = false;
  s.on("recovery:offer", (p: unknown) => {
    offerReceived = true;
    console.log("OFFER_RECEIVED " + JSON.stringify(p).slice(0, 120));
  });

  s.emit("keys:publish", { bundle });
  await new Promise((f) => setTimeout(f, 800)); // let the directory record land

  console.log("DEVICE " + deviceId);
  console.log("FINGERPRINT " + fingerprint);
  console.log("REQUEST_SENT");
  s.emit("recovery:request", { deviceId, fingerprint });

  await new Promise((f) => setTimeout(f, WAIT_MS));
  console.log(offerReceived ? "RESULT OFFER_RECEIVED" : "RESULT NO_OFFER");
  s.close();
}

main().then(
  () => process.exit(0),
  (e) => { console.error("harness error:", e); process.exit(1); },
);
