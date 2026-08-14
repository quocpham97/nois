// Per-frame media encryption, run off the main thread (phase D).
//
// This is what makes an SFU compatible with the product's promise: Cloudflare
// forwards our packets but every frame payload is sealed with a key derived
// from the group's MLS epoch secret, which the server never sees. RTP headers
// stay in the clear, so the SFU can still route and select layers.
//
// The frame format itself lives in call-frame-codec.ts so it can be tested
// directly; this file is only the plumbing between it and Encoded Transform.

import { importFrameKey, openFrame, sealFrame } from "./call-frame-codec";

/** epoch → key. Several are held at once because a group commit mid-call
 *  advances the epoch, and frames already in flight were sealed under the
 *  previous one. */
const keys = new Map<number, CryptoKey>();
/** Epoch to seal new frames under: the newest key we hold. */
let sendEpoch = -1;

type Frame = { data: ArrayBuffer; type?: "key" | "delta" };

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type?: string; epoch?: number; key?: ArrayBuffer };
  if (msg?.type !== "key" || typeof msg.epoch !== "number" || !msg.key) return;
  keys.set(msg.epoch, await importFrameKey(new Uint8Array(msg.key)));
  if (msg.epoch > sendEpoch) sendEpoch = msg.epoch;
  // Two epochs covers frames in flight across a commit. Holding more would
  // keep a removed member's key usable for longer than it should be.
  while (keys.size > 2) keys.delete(Math.min(...keys.keys()));
};

type Transformer = {
  readable: ReadableStream<Frame>;
  writable: WritableStream<Frame>;
  options: { operation: "encrypt" | "decrypt"; kind: string };
};

(self as unknown as { onrtctransform: (e: { transformer: Transformer }) => void }).onrtctransform =
  (event) => {
    const { readable, writable, options } = event.transformer;
    const encrypting = options.operation === "encrypt";
    readable
      .pipeThrough(
        new TransformStream<Frame, Frame>({
          async transform(frame, controller) {
            const isKeyFrame = frame.type === "key";
            const key = keys.get(sendEpoch);
            const out =
              encrypting && key
                ? await sealFrame(key, sendEpoch, options.kind, isKeyFrame, frame.data)
                : encrypting
                  ? null
                  : await openFrame(keys, options.kind, isKeyFrame, frame.data);
            // Never forward a frame we couldn't seal — that would publish
            // plaintext to the SFU, which is the one thing this exists to stop.
            // An unopenable inbound frame is dropped rather than handed to the
            // decoder as ciphertext.
            if (!out) return;
            frame.data = out;
            controller.enqueue(frame);
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => {
        /* the connection went away */
      });
  };
