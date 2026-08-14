// The frame format for end-to-end encrypted call media (phase D).
//
// Split out from the worker so it can be exercised directly — this is the part
// where a mistake means media the server can read, so it is tested rather than
// trusted (scripts/frame-crypto-harness.mts). It touches nothing but WebCrypto.
//
// Layout of a sealed frame:
//
//   [clear codec header][AES-GCM ciphertext+tag][12-byte IV][4-byte epoch]
//
// The header stays readable because the local packetizer and the SFU need it to
// route and depacketize; it is passed as additional authenticated data, so it
// can be read but not rewritten. Everything after it is opaque to the server.

/** Codec header bytes left in the clear. The video offsets are VP8's, which is
 *  why the transport pins that codec — under H.264 they would land mid-payload
 *  and corrupt every frame. */
export const CLEAR_HEADER = { audio: 1, videoKey: 10, videoDelta: 3 };
export const IV_BYTES = 12;
export const EPOCH_BYTES = 4;
/** Fixed-width, so there is no length field to disagree about. */
export const TRAILER = IV_BYTES + EPOCH_BYTES;

export function headerLength(kind: string, isKeyFrame: boolean): number {
  if (kind === "audio") return CLEAR_HEADER.audio;
  return isKeyFrame ? CLEAR_HEADER.videoKey : CLEAR_HEADER.videoDelta;
}

/** Import raw exporter bytes as an AES-GCM key. */
export function importFrameKey(raw: Uint8Array): Promise<CryptoKey> {
  // Copy: `raw` may be a view onto a larger buffer.
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal one frame. Returns null if it can't be sealed — callers must DROP such
 *  frames, never forward them, or plaintext reaches the server. */
export async function sealFrame(
  key: CryptoKey,
  epoch: number,
  kind: string,
  isKeyFrame: boolean,
  data: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const view = new Uint8Array(data);
  const headerLen = Math.min(headerLength(kind, isKeyFrame), view.byteLength);
  const header = view.subarray(0, headerLen);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  try {
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: header },
        key,
        view.subarray(headerLen),
      ),
    );
    const out = new Uint8Array(headerLen + sealed.byteLength + TRAILER);
    out.set(header, 0);
    out.set(sealed, headerLen);
    out.set(iv, headerLen + sealed.byteLength);
    new DataView(out.buffer).setUint32(out.byteLength - EPOCH_BYTES, epoch, false);
    return out.buffer;
  } catch {
    return null;
  }
}

/** Open one frame using whichever epoch it names. Null when the key is unknown
 *  (briefly true around a group commit) or authentication fails. */
export async function openFrame(
  keys: Map<number, CryptoKey>,
  kind: string,
  isKeyFrame: boolean,
  data: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const view = new Uint8Array(data);
  const headerLen = Math.min(headerLength(kind, isKeyFrame), view.byteLength);
  if (view.byteLength <= headerLen + TRAILER) return null;

  const epoch = new DataView(data).getUint32(view.byteLength - EPOCH_BYTES, false);
  const key = keys.get(epoch);
  if (!key) return null;

  const header = view.subarray(0, headerLen);
  const iv = view.subarray(view.byteLength - TRAILER, view.byteLength - EPOCH_BYTES);
  const sealed = view.subarray(headerLen, view.byteLength - TRAILER);
  try {
    const opened = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: header }, key, sealed),
    );
    const out = new Uint8Array(headerLen + opened.byteLength);
    out.set(header, 0);
    out.set(opened, headerLen);
    return out.buffer;
  } catch {
    return null; // wrong key, or the frame was altered in transit
  }
}
