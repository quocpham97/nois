// Does the call-media frame format actually protect anything?
//
// This is the piece of phase D where a mistake is invisible in a working call:
// media would flow, tiles would light up, and the SFU would be able to read
// every frame. So the format is attacked directly rather than inferred from a
// call that looks fine. Pure WebCrypto — no browser, no server, no network.
//
//   npx tsx scripts/frame-crypto-harness.mts

import {
  CLEAR_HEADER,
  TRAILER,
  importFrameKey,
  openFrame,
  sealFrame,
} from "../src/components/chat/call-frame-codec.ts";

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);

/** AES-GCM appends a 128-bit authentication tag to the ciphertext, so a sealed
 *  frame costs TRAILER + 16 = 32 bytes over the plaintext. That is real
 *  bandwidth — ~1.6 KB/s on a 50 fps audio track — and worth knowing. */
const GCM_TAG = 16;

const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const eq = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

async function main() {
  const keyA = await importFrameKey(bytes(32));
  const keyB = await importFrameKey(bytes(32));
  const keys = new Map([[7, keyA]]);

  // --- round trip, per frame kind ---------------------------------------------
  for (const [kind, isKey, headerLen] of [
    ["audio", false, CLEAR_HEADER.audio],
    ["video", true, CLEAR_HEADER.videoKey],
    ["video", false, CLEAR_HEADER.videoDelta],
  ] as const) {
    const plain = bytes(400);
    const sealed = await sealFrame(keyA, 7, kind, isKey, plain.buffer);
    const opened = sealed && (await openFrame(keys, kind, isKey, sealed));
    check(
      !!opened && eq(new Uint8Array(opened), plain),
      `${kind}${isKey ? " keyframe" : ""} survives a round trip`,
    );
    check(
      !!sealed && sealed.byteLength === plain.byteLength + TRAILER + GCM_TAG,
      `${kind}${isKey ? " keyframe" : ""} grows by exactly ${TRAILER + GCM_TAG} bytes (${sealed ? sealed.byteLength - plain.byteLength : "?"})`,
    );
    // The codec header must stay readable — the packetizer and SFU need it.
    check(
      !!sealed && eq(new Uint8Array(sealed).subarray(0, headerLen), plain.subarray(0, headerLen)),
      `${kind}${isKey ? " keyframe" : ""} leaves ${headerLen} header byte(s) in the clear`,
    );
    // ...and NOTHING else. This is the check that would catch a frame being
    // forwarded unencrypted.
    check(
      !!sealed &&
        !eq(
          new Uint8Array(sealed).subarray(headerLen, plain.byteLength),
          plain.subarray(headerLen),
        ),
      `${kind}${isKey ? " keyframe" : ""} payload is not passed through in the clear`,
    );
  }

  // --- the frame is useless without the right key -------------------------------
  const plain = bytes(300);
  const sealed = (await sealFrame(keyA, 7, "video", true, plain.buffer))!;

  check(
    (await openFrame(new Map([[7, keyB]]), "video", true, sealed)) === null,
    "a different key cannot open the frame",
  );
  check(
    (await openFrame(new Map([[8, keyA]]), "video", true, sealed)) === null,
    "the right key under the wrong epoch is not used",
  );
  check(
    (await openFrame(new Map(), "video", true, sealed)) === null,
    "an unknown epoch drops the frame instead of guessing",
  );

  // --- tampering ----------------------------------------------------------------
  const flip = (buf: ArrayBuffer, i: number) => {
    const copy = new Uint8Array(buf.slice(0));
    copy[i] ^= 0xff;
    return copy.buffer;
  };
  check(
    (await openFrame(keys, "video", true, flip(sealed, 2))) === null,
    "rewriting a CLEAR header byte fails authentication (it is signed, not just copied)",
  );
  check(
    (await openFrame(keys, "video", true, flip(sealed, CLEAR_HEADER.videoKey + 5))) === null,
    "flipping a ciphertext byte fails authentication",
  );
  check(
    (await openFrame(keys, "video", true, flip(sealed, sealed.byteLength - TRAILER + 1))) === null,
    "flipping an IV byte fails authentication",
  );
  check(
    (await openFrame(keys, "video", true, sealed.slice(0, 4))) === null,
    "a truncated frame is rejected, not read out of bounds",
  );

  // --- IVs must never repeat under one key ---------------------------------------
  const ivs = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const s = new Uint8Array((await sealFrame(keyA, 7, "audio", false, bytes(80).buffer))!);
    ivs.add(String(s.subarray(s.byteLength - TRAILER, s.byteLength - 4)));
  }
  check(ivs.size === 200, `200 frames used 200 distinct IVs (${ivs.size})`);

  // --- epoch is carried faithfully ------------------------------------------------
  const old = (await sealFrame(keyA, 7, "audio", false, plain.buffer))!;
  const rotated = new Map([
    [7, keyA],
    [8, keyB],
  ]);
  check(
    !!(await openFrame(rotated, "audio", false, old)),
    "a frame from the previous epoch still opens after a rekey",
  );
  const fresh = (await sealFrame(keyB, 8, "audio", false, plain.buffer))!;
  check(
    !!(await openFrame(rotated, "audio", false, fresh)),
    "a frame from the new epoch opens too",
  );

  console.log("\n" + results.join("\n"));
  const ok = results.every((r) => r.startsWith("PASS"));
  console.log("\n" + (ok ? "ALL PASS ✅" : "SOME FAILED ❌"));
  process.exit(ok ? 0 : 1);
}

void main();
