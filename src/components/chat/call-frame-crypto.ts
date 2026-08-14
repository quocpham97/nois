// Main-thread half of per-frame media encryption (phase D).
//
// Owns the worker, feeds it keys derived from the group's MLS epoch secret, and
// attaches the transform to each RTP sender and receiver. See
// call-frame-crypto.worker.ts for the frame layout and docs/calls-production.md
// for why this exists at all: without it an SFU can read every call.

export type FrameCrypto = {
  /** Derived key material for one MLS epoch. Safe to call repeatedly. */
  addKey: (epoch: number, key: Uint8Array) => void;
  /** Seal everything this sender transmits. */
  protectSender: (sender: RTCRtpSender, kind: string) => void;
  /** Open everything this receiver delivers. */
  protectReceiver: (receiver: RTCRtpReceiver, kind: string) => void;
  close: () => void;
};

/** Does this browser support WebRTC Encoded Transform at all?
 *
 *  There is deliberately no fallback. Chrome's older `createEncodedStreams` is
 *  not implemented here, and a client that can't encrypt frames must not join
 *  an SFU call in the clear — silently downgrading would contradict what
 *  PrivacyPanel tells users. Such clients stay on the mesh. */
export function frameCryptoSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { RTCRtpScriptTransform?: unknown })
      .RTCRtpScriptTransform === "function"
  );
}

type ScriptTransformCtor = new (
  worker: Worker,
  options: { operation: "encrypt" | "decrypt"; kind: string },
) => unknown;

export function createFrameCrypto(): FrameCrypto | null {
  if (!frameCryptoSupported()) return null;
  const worker = new Worker(new URL("./call-frame-crypto.worker.ts", import.meta.url), {
    type: "module",
  });
  const ScriptTransform = (window as unknown as { RTCRtpScriptTransform: ScriptTransformCtor })
    .RTCRtpScriptTransform;

  return {
    addKey(epoch, key) {
      // Copy into a fresh buffer: the worker takes ownership of what it's sent
      // and the caller's view may be a slice of a larger allocation.
      const copy = new Uint8Array(key);
      worker.postMessage({ type: "key", epoch, key: copy.buffer }, [copy.buffer]);
    },
    protectSender(sender, kind) {
      (sender as unknown as { transform: unknown }).transform = new ScriptTransform(worker, {
        operation: "encrypt",
        kind,
      });
    },
    protectReceiver(receiver, kind) {
      (receiver as unknown as { transform: unknown }).transform = new ScriptTransform(worker, {
        operation: "decrypt",
        kind,
      });
    },
    close() {
      worker.terminate();
    },
  };
}
