"use client";

/**
 * Sealing policy: given a conversation and a body, produce the envelope that
 * goes on the wire — or null when this device cannot encrypt for it.
 *
 * A DM seals pairwise. A group prefers MLS (RFC 9420 — the live scheme) and
 * falls back to sender-keys while a group's members aren't all MLS-capable yet.
 * Old sender-keys history keeps decrypting regardless: the decrypt path routes by
 * envelope tag, so the two schemes coexist per group during the transition.
 *
 * `sealFor` is the one entry point every send path uses (message, edit, read
 * receipt), so the DM/group branch is stated once rather than at each call site.
 */
import { useCallback, useMemo } from "react";
import { groupGet, groupPut } from "@/lib/crypto/identity";
import {
  deserializeState,
  encryptGroupMessage,
  serializeState,
  type SenderKeyWire,
} from "@/lib/crypto/group";
import type { MessageContent } from "@/lib/crypto/types";
import { dmPeerId, isDm } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import { MLS_ENABLED } from "../lib/mls-directory";
import type { KeyMaterial } from "./use-key-material";
import type { Mls } from "./use-mls";

export type Seal = ReturnType<typeof useSeal>;

export function useSeal({
  socket,
  userId,
  keys,
  mls,
}: {
  socket: TypedSocket | null;
  userId: string;
  keys: KeyMaterial;
  mls: Mls;
}) {
  const { getSecrets, fetchGroupBundles, ensureSenderKeyDistributed, buildEnvelope } = keys;

  const buildGroupEnc = useCallback(
    async (groupId: string, content: MessageContent): Promise<string | null> => {
      if (isDm(groupId)) return null;
      if (MLS_ENABLED) {
        try {
          const mlsEnc = await mls.buildEnc(groupId, content);
          if (mlsEnc) return mlsEnc;
          // No MLS group possible yet → sender-keys below keeps the group E2EE.
        } catch (err) {
          // MLS is the preferred scheme, not the only one, and this fallback is
          // the whole point of the two coexisting. An exception here — a commit
          // rejected while membership churns, an unreadable state, a ts-mls edge
          // case — used to propagate out and FAIL THE MESSAGE ("encryption isn't
          // available here yet"), which is a far worse outcome than sending under
          // the older scheme. Membership changes are exactly when this path does
          // its most failure-prone work, so it must not be load-bearing.
          console.warn("[mls] encrypt failed; falling back to sender-keys", groupId, err);
        }
      }
      const secrets = await getSecrets();
      if (!secrets || !socket) return null;
      const members = await fetchGroupBundles(groupId);
      // No co-member device has published keys yet (e.g. everyone else was just
      // added and hasn't signed in). Encrypt anyway rather than refusing: our
      // sender-key seed is deliberately STABLE and re-distributed whenever the
      // member-device set changes, so this message becomes readable the moment
      // someone sets their keys up — either via that redistribution or via their
      // pull-on-miss request. Refusing was a leftover from when returning null
      // here meant "send it in plaintext"; under default-E2EE it just loses it.
      await ensureSenderKeyDistributed(groupId, members, secrets);
      const wire = await groupGet<SenderKeyWire>(userId, `send:${groupId}`);
      if (!wire) return null;
      const { env, next } = await encryptGroupMessage(
        deserializeState(wire),
        secrets.deviceId,
        content,
      );
      await groupPut(userId, `send:${groupId}`, serializeState(next));
      return JSON.stringify(env);
    },
    [getSecrets, socket, fetchGroupBundles, ensureSenderKeyDistributed, userId, mls],
  );

  /** Seal a body for a conversation, whichever kind it is. */
  const sealFor = useCallback(
    (
      groupId: string,
      content: MessageContent,
      opts?: { skipOneTimePreKey?: boolean },
    ): Promise<string | null> =>
      isDm(groupId)
        ? buildEnvelope(dmPeerId(groupId), content, opts)
        : buildGroupEnc(groupId, content),
    [buildEnvelope, buildGroupEnc],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      buildGroupEnc,
      sealFor,
    }),
    [buildGroupEnc, sealFor],
  );
}
