"use client";

/**
 * MLS (RFC 9420) group encryption — the LIVE scheme for groups.
 *
 * Everything about a group's MLS life lives here: this device's KeyPackage, the
 * per-group ClientState, applying the delivery service's ordered commits,
 * syncing membership drift, establishing a group, sealing an application
 * message, and exporting a call media key. Ordering comes from the server-side
 * delivery service (server/mls-ds.ts).
 *
 * Concurrency: every ClientState mutation goes through a per-group mutex
 * (`withMlsLock`) because encrypt advances the sender ratchet, decrypt the
 * receiver chain, and a commit the epoch — two interleaved awaits advancing from
 * the same state would fork the ratchet. Only the OUTERMOST entry points take
 * the lock (buildMlsEnc, the decrypt branch, the commit/welcome handlers, the
 * connect drain); the inner helpers (ensureMlsGroup, applyCommitsSince,
 * syncMembership) must be called with it already held.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { groupGet, groupPut, type DeviceSecrets } from "@/lib/crypto/identity";
import type { ClientState as MlsClientState, KeyPackage as MlsKeyPackage } from "ts-mls";
import type { MlsKeyPair, StoredMlsKeyPair } from "@/lib/crypto/mls";
import type { MessageContent } from "@/lib/crypto/types";
import type { MlsCommitAck, MlsFetchGroupResult } from "@/lib/socket-events";
import { chat } from "@/stores/chat-store";
import { isDm } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import { MLS_ENABLED, loadMls, mlsAddCandidates } from "../lib/mls-directory";

/** Ceiling on leaf removals folded into one membership commit — see the note at
 *  the removal pass in syncMembership. */
const MAX_EVICTIONS_PER_COMMIT = 32;

export type Mls = ReturnType<typeof useMls>;

export function useMls({
  socket,
  userId,
  sessionDeviceId,
  getSecrets,
}: {
  socket: TypedSocket | null;
  userId: string;
  sessionDeviceId: string | null;
  getSecrets: () => Promise<DeviceSecrets | null>;
}) {
  /** In-memory per-group ClientState (persisted under `mls2:<groupId>`), plus
   *  this DEVICE's long-lived KeyPackage keypair (persisted as `mlskp` so a
   *  Welcome sealed to it survives reconnects). */
  const statesRef = useRef<Map<string, MlsClientState>>(new Map());
  const kpRef = useRef<MlsKeyPair | null>(null);
  /** Last commit `seq` applied per group (persisted as `mls2seq:<id>`), so the
   *  delivery service's ordered commits apply exactly once, in order. */
  const seqRef = useRef<Map<string, number>>(new Map());
  /** Per-group throttle for membership drift syncs (see syncMembership). */
  const syncedAtRef = useRef<Map<string, number>>(new Map());
  /** First time we saw an MLS message for a group we hold no state for — after a
   *  grace window those messages lock (they predate our membership). */
  const waitRef = useRef<Map<string, number>>(new Map());
  /** Session cache of successfully-decrypted messages, by msgId. MLS decrypt is
   *  SINGLE-SHOT (it advances the receiver ratchet — a re-decrypt throws "gen in
   *  the past"), unlike the idempotent sender-keys/DM paths, so when overlapping
   *  decrypt passes process the same message the second one must return the
   *  cached plaintext rather than a spurious 🔒. */
  const plainRef = useRef<
    Map<string, Partial<import("@/lib/chat-data").Message> & { att?: { key: string; iv: string } }>
  >(new Map());
  /** The flip side of plainRef: envelopes this session has already proven
   *  unopenable, so several in-flight passes don't each pay a decrypt and log. */
  const deadRef = useRef<Set<string>>(new Set());

  const locksRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const withMlsLock = useCallback(
    <T,>(groupId: string, fn: () => Promise<T>): Promise<T> => {
      const locks = locksRef.current;
      const prev = locks.get(groupId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      locks.set(groupId, next.then(() => undefined, () => undefined));
      return next;
    },
    [],
  );

  // Storage keys are VERSIONED (`mls2:` / `mls2seq:`): v1 states from the
  // flagged-off era used bare-userId leaf identities and session-only keypairs —
  // unusable under the multi-device protocol — so they're simply orphaned.
  const loadState = useCallback(
    async (groupId: string): Promise<MlsClientState | null> => {
      const cached = statesRef.current.get(groupId);
      if (cached) return cached;
      const b64 = await groupGet<string>(userId, `mls2:${groupId}`);
      if (!b64) return null;
      try {
        const state = (await loadMls()).mlsDeserializeState(b64);
        statesRef.current.set(groupId, state);
        return state;
      } catch (err) {
        // A state we can't read is worse than no state at all: every send would
        // keep throwing through the MLS path. Clear it (an empty value reads as
        // absent above) so ensureGroup can re-establish, or re-join when a
        // Welcome arrives.
        console.warn("[mls] discarding unreadable state", groupId, err);
        await groupPut(userId, `mls2:${groupId}`, "");
        return null;
      }
    },
    [userId],
  );

  const saveState = useCallback(
    async (groupId: string, state: MlsClientState) => {
      statesRef.current.set(groupId, state);
      await groupPut(
        userId,
        `mls2:${groupId}`,
        (await loadMls()).mlsSerializeState(state),
      );
    },
    [userId],
  );

  /**
   * This device's KeyPackage keypair — loaded from the groups store, generated
   * (and persisted) once per device. Long-lived on purpose: a Welcome is sealed
   * to the published package, so the private half must survive reconnects for
   * offline adds to be joinable. Never leaves this device (excluded from
   * device-to-device recovery offers; see use-device-recovery approveDevice).
   */
  const keyPair = useCallback(async (): Promise<MlsKeyPair | null> => {
    const mls = await loadMls();
    const secrets = await getSecrets();
    if (!secrets) return null; // device identity not provisioned yet
    // The pair is only usable while it still names THIS device: a PIN restore
    // adopts the backed-up device id mid-session, and republishing the old pair
    // under the new id would leave two directory rows sharing one signature key
    // — which MLS reads as one client and rejects the commit over. A legacy
    // (pre-multi-device) pair carries the bare userId and stays valid.
    const fits = (kp: MlsKeyPair) => {
      const claimed = mls.mlsKeyPackageIdentity(kp.publicPackage);
      if (claimed === null) return false;
      const by = mls.mlsParseIdentity(claimed);
      return (
        by.userId === userId &&
        (by.deviceId === "" || by.deviceId === secrets.deviceId)
      );
    };
    if (kpRef.current && fits(kpRef.current)) return kpRef.current;
    const stored = await groupGet<StoredMlsKeyPair>(userId, "mlskp");
    if (stored) {
      const kp = mls.mlsImportKeyPair(stored);
      if (kp && fits(kp)) {
        kpRef.current = kp;
        return kp;
      }
    }
    const kp = await mls.mlsGenerateKeyPackage(userId, secrets.deviceId);
    kpRef.current = kp;
    await groupPut(userId, "mlskp", mls.mlsExportKeyPair(kp));
    return kp;
  }, [userId, getSecrets]);

  const fetchGroup = useCallback(
    (groupId: string): Promise<MlsFetchGroupResult> =>
      new Promise((resolve) => {
        if (!socket) return resolve({ packages: [], memberIds: [] });
        socket
          .timeout(5000)
          .emit("mls:fetchGroup", { groupId }, (err, res) =>
            resolve(err || !res ? { packages: [], memberIds: [] } : res),
          );
      }),
    [socket],
  );

  /** Submit one commit (+ welcomes) through the delivery service. */
  const submitCommit = useCallback(
    (
      groupId: string,
      fromEpoch: number,
      commit: string,
      welcomes: { toUserId: string; toDeviceId: string; welcome: string }[],
    ): Promise<MlsCommitAck> =>
      new Promise((resolve) => {
        if (!socket) return resolve({ ok: false, reason: "error", currentEpoch: 0 });
        // One add-commit yields ONE Welcome for everyone it adds, so callers
        // naturally hand us the same blob once per target device. Send each
        // distinct blob once with the devices it is for: the old shape put a full
        // copy per device on the wire, which reached 30 MB in a group whose three
        // members had accumulated many devices — past `ws`'s frame limit, which
        // drops the SOCKET rather than the message and so took down every call
        // and commit riding on it.
        const byWelcome = new Map<string, { toUserId: string; toDeviceId: string }[]>();
        for (const w of welcomes) {
          const targets = byWelcome.get(w.welcome);
          const target = { toUserId: w.toUserId, toDeviceId: w.toDeviceId };
          if (targets) targets.push(target);
          else byWelcome.set(w.welcome, [target]);
        }
        const welcomeFor = [...byWelcome].map(([welcome, targets]) => ({
          welcome,
          targets,
        }));
        socket
          .timeout(8000)
          .emit("mls:commit", { groupId, fromEpoch, commit, welcomeFor }, (err, r) =>
            resolve(err || !r ? { ok: false, reason: "error", currentEpoch: 0 } : r),
          );
      }),
    [socket],
  );

  const getSeq = useCallback(
    async (groupId: string): Promise<number> => {
      const cached = seqRef.current.get(groupId);
      if (cached != null) return cached;
      const stored = (await groupGet<number>(userId, `mls2seq:${groupId}`)) ?? 0;
      seqRef.current.set(groupId, stored);
      return stored;
    },
    [userId],
  );

  const setSeq = useCallback(
    async (groupId: string, seq: number) => {
      seqRef.current.set(groupId, seq);
      await groupPut(userId, `mls2seq:${groupId}`, seq);
    },
    [userId],
  );

  /** Apply the delivery service's ordered commits with seq > our last-applied
   *  one. Processing a commit built for a different epoch throws — we stop there
   *  (a later fetch/relay retries once the missing pieces arrive). */
  const applyCommitsSince = useCallback(
    async (groupId: string) => {
      if (!socket) return;
      const state = await loadState(groupId);
      if (!state) return;
      const since = await getSeq(groupId);
      const res = await new Promise<{ seq: number; commit: string }[]>((resolve) => {
        socket
          .timeout(5000)
          .emit("mls:fetchCommits", { groupId, sinceSeq: since }, (err, r) =>
            resolve(err || !r ? [] : r.commits),
          );
      });
      const mls = await loadMls();
      let cur = state;
      for (const { seq, commit } of res) {
        try {
          cur = await mls.mlsProcessCommit(cur, commit);
        } catch {
          break; // wrong epoch for us yet — stop; we'll retry on the next signal
        }
        await saveState(groupId, cur);
        await setSeq(groupId, seq);
      }
    },
    [socket, loadState, getSeq, saveState, setSeq],
  );

  /**
   * Sync the group's leaves to the group's ACTUAL membership (call with the
   * group lock held, state already loaded). Diffs the ratchet-tree leaves
   * against the server-authoritative roster + published per-device packages:
   *   * a member device with no leaf → ADD (this is how post-establishment
   *     joiners — and a member's brand-new device — get in)
   *   * a leaf whose user left the group → REMOVE
   *   * a leaf whose device republished a DIFFERENT signature key (device reset
   *     its e2ee store) → REMOVE + re-ADD with the new package
   * All folded into ONE commit through the delivery service; on `conflict`
   * someone else committed first — catch up and re-diff (once). Throttled per
   * group so ordinary sends don't pay a fetch round-trip each time.
   */
  const syncMembership = useCallback(
    async (groupId: string, state: MlsClientState): Promise<MlsClientState> => {
      const now = Date.now();
      const last = syncedAtRef.current.get(groupId) ?? 0;
      if (now - last < 30_000) return state;
      syncedAtRef.current.set(groupId, now);
      const secrets = await getSecrets();
      if (!secrets) return state;
      const { packages, memberIds, liveDevices } = await fetchGroup(groupId);
      if (!memberIds.length) return state;
      const mls = await loadMls();
      const me = mls.mlsIdentity(userId, secrets.deviceId);
      const memberSet = new Set(memberIds);
      // Devices the directory has heard from recently. Absent on an older
      // server, in which case device eviction is skipped entirely.
      const liveSet = new Set(
        (liveDevices ?? []).map((d) => mls.mlsIdentity(d.userId, d.deviceId)),
      );
      let cur = state;
      for (let attempt = 0; attempt < 2; attempt++) {
        const leaves = mls.mlsGroupMembers(cur);
        const leafByIdentity = new Map(leaves.map((l) => [l.identity, l]));
        const adds: MlsKeyPackage[] = [];
        const targets: { toUserId: string; toDeviceId: string }[] = [];
        const removes: number[] = [];
        for (const c of mlsAddCandidates(mls, packages, me)) {
          if (!memberSet.has(c.userId)) continue; // package of a non-member
          const leaf = leafByIdentity.get(c.identity);
          if (leaf && leaf.sigKey === c.sigKey) continue; // already in, unchanged
          // A signature key already in the tree under ANOTHER identity would
          // make this an Add for someone the group already holds — equally fatal
          // to the commit. Leave it to the remove pass to clear first.
          if (leaves.some((l) => l.sigKey === c.sigKey && l.identity !== c.identity))
            continue;
          // Reset device (republished under a new signature key): its stale leaf
          // goes in the same commit as the re-add.
          if (leaf) removes.push(leaf.leafIndex);
          adds.push(c.kp);
          targets.push({ toUserId: c.userId, toDeviceId: c.deviceId });
        }
        // Expiries are collected apart from the removes above, which are PAIRED
        // with an add (a reset device's stale leaf must go in the same commit as
        // its re-add). Capping a combined list could drop one of those and leave
        // the commit holding two leaves for one client, which MLS rejects
        // outright — so only this list is ever truncated.
        const expired: number[] = [];
        for (const l of leaves) {
          if (l.identity === me) continue;
          // Never self-evict on a roster hiccup; drop leaves whose USER is
          // genuinely not a member anymore.
          if (l.userId !== userId && !memberSet.has(l.userId)) {
            removes.push(l.leafIndex);
            continue;
          }
          // A leaf whose DEVICE is gone. Every browser profile that ever signed
          // in is a distinct device, and its leaf used to stay in the tree for
          // good — so the tree only grew, and since a Welcome embeds the whole
          // tree, every join blob grew with it (quadratic in queued bytes).
          // Expiring the leaf is what bounds both.
          //
          // Self-healing rather than destructive: a device that comes back
          // republishes, becomes live, and is re-added by the add pass above —
          // at the current epoch, so it reads from then on and recovers older
          // messages from the user's own encrypted history store.
          //
          // Legacy leaves (bare-userId identity, deviceId "") are left alone:
          // a live device may still hold a legacy keypair, and evicting one the
          // add pass would immediately re-add would commit in a loop.
          if (liveSet.size && l.deviceId && !liveSet.has(l.identity)) {
            expired.push(l.leafIndex);
          }
        }
        // A huge commit is the shape that has hurt before (a 30 MB frame took the
        // socket down), and a long-accumulated backlog is exactly when this runs.
        // Clearing it over several syncs costs nothing — each is a normal commit.
        if (expired.length > MAX_EVICTIONS_PER_COMMIT) {
          console.warn(
            `[mls] ${expired.length} expired leaves in ${groupId}; evicting ${MAX_EVICTIONS_PER_COMMIT} this commit`,
          );
          expired.length = MAX_EVICTIONS_PER_COMMIT;
        }
        const res = await mls.mlsSyncCommit(cur, adds, [...removes, ...expired]);
        if (!res) return cur; // membership already in sync
        const ack = await submitCommit(
          groupId,
          mls.mlsEpoch(cur),
          res.commit,
          res.welcome ? targets.map((t) => ({ ...t, welcome: res.welcome! })) : [],
        );
        if (ack.ok) {
          await saveState(groupId, res.state);
          await setSeq(groupId, ack.seq);
          return res.state;
        }
        if (ack.reason !== "conflict") return cur;
        // Someone else's commit won this epoch — apply it and re-diff.
        await applyCommitsSince(groupId);
        cur = (await loadState(groupId)) ?? cur;
      }
      return cur;
    },
    [
      getSecrets,
      fetchGroup,
      userId,
      submitCommit,
      saveState,
      setSeq,
      applyCommitsSince,
      loadState,
    ],
  );

  /**
   * Ensure we hold an MLS group for a group (call with the group lock held):
   * load it (then drift-sync membership), else ESTABLISH it — one commit adding
   * every member device, submitted through the delivery service so exactly one
   * member's establishment wins. On `conflict`/`no_group` another member
   * established first: we discard our local attempt and join when their Welcome
   * arrives.
   *
   * Establishment requires EVERY co-member user to have at least one published
   * KeyPackage — otherwise we return null and the send falls back to sender-keys,
   * so a group keeps working until all its members have run an MLS-capable client
   * once. Post-establishment stragglers are handled by syncMembership instead.
   */
  const ensureGroup = useCallback(
    async (groupId: string): Promise<MlsClientState | null> => {
      const existing = await loadState(groupId);
      if (existing) return syncMembership(groupId, existing);
      if (!socket) return null;
      const kp = await keyPair();
      const secrets = await getSecrets();
      if (!kp || !secrets) return null;
      const mls = await loadMls();
      const { packages, memberIds } = await fetchGroup(groupId);
      const me = mls.mlsIdentity(userId, secrets.deviceId);
      const targets = mlsAddCandidates(mls, packages, me);
      const coveredUsers = new Set(targets.map((t) => t.userId));
      const coMembers = memberIds.filter((id) => id !== userId);
      if (!coMembers.length || !coMembers.every((id) => coveredUsers.has(id))) {
        return null; // not everyone is MLS-capable yet → sender-keys fallback
      }
      const created = await mls.mlsCreateGroup(groupId, kp);
      const added = await mls.mlsAddMembers(created, targets.map((m) => m.kp));
      const ack = await submitCommit(
        groupId,
        0,
        added.commit,
        targets.map((m) => ({
          toUserId: m.userId,
          toDeviceId: m.deviceId,
          welcome: added.welcome,
        })),
      );
      if (!ack.ok) {
        // Lost the establishment race (or transport error) — don't keep our fork;
        // we'll join via the winner's Welcome. Catch up any commits meanwhile.
        await applyCommitsSince(groupId);
        return null;
      }
      await saveState(groupId, added.state);
      await setSeq(groupId, ack.seq);
      return added.state;
    },
    [
      socket,
      loadState,
      syncMembership,
      keyPair,
      getSecrets,
      fetchGroup,
      userId,
      submitCommit,
      saveState,
      setSeq,
      applyCommitsSince,
    ],
  );

  /** Build an MLS application message (tagged `t:"mls"` so the decrypt path
   *  routes it here). Null when no group exists and one can't be established yet
   *  (the caller falls back to sender-keys). */
  const buildEnc = useCallback(
    (groupId: string, content: MessageContent): Promise<string | null> => {
      if (isDm(groupId)) return Promise.resolve(null);
      return withMlsLock(groupId, async () => {
        const state = await ensureGroup(groupId);
        if (!state) return null;
        const { state: next, wire } = await (await loadMls()).mlsEncrypt(state, content);
        await saveState(groupId, next);
        return JSON.stringify({ t: "mls", w: wire });
      });
    },
    [ensureGroup, saveState, withMlsLock],
  );

  /**
   * Per-call media key, for encrypting frames the SFU forwards but must not be
   * able to read (phase D — docs/calls-production.md).
   *
   * The whole key agreement is one exporter call: members of an MLS group at the
   * same epoch derive identical bytes without exchanging anything, and the epoch
   * is returned alongside so frames can say which key encrypted them. `callId` is
   * the exporter context, so two concurrent calls in one group never share a key.
   *
   * No lock around the export itself: exporting reads the key schedule, it
   * doesn't advance a ratchet — but ESTABLISHING the group does, so that part
   * takes it.
   */
  const exportCallKey = useCallback(
    async (groupId: string, callId: string) => {
      if (!MLS_ENABLED || isDm(groupId)) return null;
      // ESTABLISH the group, don't merely read it. A group nobody has messaged in
      // yet holds no MLS state at all, so waiting for some to appear would wait
      // forever — `ensureGroup` is what publishes the commit that creates it.
      // Still returns null while co-members haven't published their key packages,
      // which is transient and worth retrying (see call-context).
      const state = await withMlsLock(groupId, () => ensureGroup(groupId));
      if (!state) return null;
      const mls = await loadMls();
      return {
        epoch: mls.mlsEpoch(state),
        key: await mls.mlsExportSecret(
          state,
          "chat-app call media",
          new TextEncoder().encode(callId),
          32,
        ),
      };
    },
    [ensureGroup, withMlsLock],
  );

  // Relayed Commits (membership changes) and Welcomes. Apply an accepted commit
  // in seq order: in-order → apply directly; a gap (we missed one) → fetch and
  // apply the ordered range; already-applied → ignore. This is what keeps every
  // member's ratchet tree in lockstep.
  useEffect(() => {
    if (!MLS_ENABLED || !socket) return;

    const onCommit = ({
      groupId,
      seq,
      commit,
    }: {
      groupId: string;
      seq: number;
      commit: string;
    }) =>
      withMlsLock(groupId, async () => {
        const state = await loadState(groupId);
        if (!state) return;
        const last = await getSeq(groupId);
        if (seq <= last) return; // already applied
        if (seq === last + 1) {
          try {
            await saveState(
              groupId,
              await (await loadMls()).mlsProcessCommit(state, commit),
            );
            await setSeq(groupId, seq);
          } catch {
            return; // not our epoch yet — a catch-up will retry
          }
        } else {
          await applyCommitsSince(groupId); // gap → fetch + apply in order
        }
        chat().bumpChainVersion();
      });

    const onWelcome = async ({
      groupId,
      welcome,
      seq,
      toDeviceId,
    }: {
      groupId: string;
      welcome: string;
      seq: number;
      toDeviceId: string;
    }) => {
      // Welcomes are sealed per DEVICE — this one may be a sibling device's.
      const secrets = await getSecrets();
      if (!secrets || (toDeviceId && toDeviceId !== secrets.deviceId)) return;
      await withMlsLock(groupId, async () => {
        if (await loadState(groupId)) return; // already a member
        const kp = await keyPair();
        if (!kp) return; // no device KeyPackage → can't join
        try {
          await saveState(
            groupId,
            await (await loadMls()).mlsJoinFromWelcome(welcome, kp),
          );
          await setSeq(groupId, seq); // resume catch-up after the commit that added us
          waitRef.current.delete(groupId);
          chat().bumpChainVersion();
          await applyCommitsSince(groupId); // apply any commits after our add
        } catch (err) {
          // Welcome for a stale KeyPackage of this device / malformed. Surfaced
          // in the console because an unjoinable welcome means this group stays
          // locked until a membership sync re-adds us.
          console.warn("[mls] welcome join failed", groupId, err);
        }
      });
    };

    socket.on("mls:commit", onCommit);
    socket.on("mls:welcome", onWelcome);
    return () => {
      socket.off("mls:commit", onCommit);
      socket.off("mls:welcome", onWelcome);
    };
  }, [
    socket,
    withMlsLock,
    loadState,
    getSeq,
    saveState,
    setSeq,
    applyCommitsSince,
    getSecrets,
    keyPair,
  ]);

  // On connect, publish this DEVICE's KeyPackage (so others can add us) and
  // drain the Welcomes queued for it while it was offline (joining each group +
  // catching up its commits).
  useEffect(() => {
    // sessionDeviceId turning non-null is the "identity provisioned" signal —
    // the effect re-runs then, so the publish never races provisioning.
    if (!MLS_ENABLED || !socket || !sessionDeviceId) return;
    const s = socket;
    let cancelled = false;
    void (async () => {
      const kp = await keyPair();
      if (cancelled || !kp) return;
      const mls = await loadMls();
      s.emit("mls:publishKeyPackage", {
        deviceId: sessionDeviceId,
        keyPackage: mls.mlsEncodeKeyPackage(kp.publicPackage),
      });
      const { welcomes } = await new Promise<{
        welcomes: { groupId: string; welcome: string; seq: number }[];
      }>((resolve) => {
        s.timeout(5000).emit(
          "mls:drainWelcomes",
          { deviceId: sessionDeviceId },
          (err, r) => resolve(err || !r ? { welcomes: [] } : r),
        );
      });
      for (const w of welcomes) {
        if (cancelled) return;
        await withMlsLock(w.groupId, async () => {
          if (await loadState(w.groupId)) return; // already joined
          try {
            await saveState(w.groupId, await mls.mlsJoinFromWelcome(w.welcome, kp));
            await setSeq(w.groupId, w.seq);
            waitRef.current.delete(w.groupId);
            await applyCommitsSince(w.groupId);
          } catch {
            // welcome for a stale KeyPackage of this device — skip
          }
        });
      }
      if (welcomes.length) chat().bumpChainVersion();
    })();
    return () => {
      cancelled = true;
    };
  }, [
    socket,
    sessionDeviceId,
    keyPair,
    loadState,
    saveState,
    setSeq,
    applyCommitsSince,
    withMlsLock,
  ]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      plainRef,
      deadRef,
      waitRef,
      withMlsLock,
      loadState,
      saveState,
      buildEnc,
      exportCallKey,
    }),
    [plainRef, deadRef, waitRef, withMlsLock, loadState, saveState, buildEnc, exportCallKey],
  );
}
