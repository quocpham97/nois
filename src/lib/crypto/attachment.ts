// Symmetric encryption for message attachments (images/files). Each file gets a
// fresh random AES-256-GCM key + IV; the ciphertext is uploaded to opaque blob
// storage (UploadThing) and the key/iv are delivered to recipients inside the
// E2EE message envelope (see crypto/session.ts + crypto/group.ts). The storage
// host only ever holds ciphertext.

"use client";

const ALG = "AES-GCM";

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Encrypt a file's bytes. Returns the ciphertext blob + base64 key and iv. */
export async function encryptFile(
  file: File,
): Promise<{ ciphertext: Blob; key: string; iv: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, ALG, false, [
    "encrypt",
  ]);
  const ct = await crypto.subtle.encrypt(
    { name: ALG, iv },
    key,
    await file.arrayBuffer(),
  );
  return {
    ciphertext: new Blob([ct], { type: "application/octet-stream" }),
    key: toB64(raw),
    iv: toB64(iv),
  };
}

/** Decrypt ciphertext bytes back into a Blob (tagged with the original mime). */
export async function decryptToBlob(
  buf: ArrayBuffer,
  keyB64: string,
  ivB64: string,
  mime?: string,
): Promise<Blob> {
  const key = await crypto.subtle.importKey("raw", fromB64(keyB64), ALG, false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    { name: ALG, iv: fromB64(ivB64) },
    key,
    buf,
  );
  return new Blob([pt], mime ? { type: mime } : undefined);
}
