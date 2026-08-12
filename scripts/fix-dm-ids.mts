// Re-key legacy DMs from `id = <recipient uid>` to `id = dmIdFor(both uids)`.
//
// The old scheme keyed a DM by the recipient alone, so (a) every sender who
// messaged the same person shared one thread, and (b) each of A→B and B→A
// created a separate half of the same conversation. This walks the `group`
// table and fixes what is fixable:
//   - a DM with exactly 2 members  -> re-keyed to its pair id (merged, if the
//     mirror-image thread for the same pair also exists)
//   - a DM with any other member count -> unsplittable: its messages belong to
//     several different conversations and the ones authored by the id-owner
//     can't be attributed to a peer at all. Reported, and only deleted when
//     you pass --purge-broken.
//
// Dry run by default. Run:
//   npx tsx --env-file=.env.local scripts/fix-dm-ids.mts [--apply] [--purge-broken]

import { getPool } from "../src/lib/db.ts";
import { dmIdFor } from "../src/lib/dm-id.ts";

const APPLY = process.argv.includes("--apply");
const PURGE = process.argv.includes("--purge-broken");
const pool = getPool();

// Every table keyed by group_id. `dedupe` names the remaining PK columns for
// tables whose PK includes group_id — on a merge those rows can collide, so the
// old group's duplicates are dropped before the id is rewritten.
const TABLES: { name: string; dedupe?: string[] }[] = [
  { name: "message" },
  { name: "reaction" },
  { name: "pin" },
  { name: "group_member", dedupe: ["user_id"] },
  { name: "read_cursor", dedupe: ["user_id"] },
  { name: "sender_key", dedupe: ["sender_device"] },
  { name: "message_receipt", dedupe: ["user_id", "device_id"] },
];

const dms = await pool.query<{ id: string }>(
  `SELECT id FROM "group" WHERE type = 'dm' ORDER BY id`,
);

let migrated = 0;
let merged = 0;
const broken: { id: string; members: string[]; messages: number }[] = [];

for (const { id } of dms.rows) {
  const mem = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM group_member WHERE group_id = $1 ORDER BY user_id`,
    [id],
  );
  const members = mem.rows.map((r) => r.user_id);
  const msgs = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM message WHERE group_id = $1`,
    [id],
  );
  const messages = msgs.rows[0].n;

  if (members.length !== 2) {
    broken.push({ id, members, messages });
    continue;
  }

  const target = dmIdFor(members[0], members[1]);
  if (target === id) continue; // already pair-keyed

  const exists = await pool.query(`SELECT 1 FROM "group" WHERE id = $1`, [target]);
  const isMerge = exists.rowCount! > 0;
  console.log(
    `${isMerge ? "MERGE" : "REKEY"} ${id} -> ${target}  ` +
      `(${members.join(" + ")}, ${messages} messages)`,
  );
  if (!APPLY) continue;

  for (const { name, dedupe } of TABLES) {
    if (isMerge && dedupe) {
      const on = dedupe.map((c) => `old.${c} = new.${c}`).join(" AND ");
      await pool.query(
        `DELETE FROM ${name} old
          WHERE old.group_id = $1
            AND EXISTS (SELECT 1 FROM ${name} new
                         WHERE new.group_id = $2 AND ${on})`,
        [id, target],
      );
    }
    await pool.query(`UPDATE ${name} SET group_id = $2 WHERE group_id = $1`, [
      id,
      target,
    ]);
  }
  if (isMerge) {
    await pool.query(`DELETE FROM "group" WHERE id = $1`, [id]);
    // Two merged halves each numbered their messages from 1. Renumber by id
    // (which is timestamp-ordered) so per-group seq is unique and monotonic
    // again, and drop the read cursors those stale seqs refer to.
    await pool.query(
      `UPDATE message m SET seq = r.rn
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn
                 FROM message WHERE group_id = $1) r
        WHERE m.id = r.id`,
      [target],
    );
    await pool.query(`DELETE FROM read_cursor WHERE group_id = $1`, [target]);
    merged++;
  } else {
    await pool.query(`UPDATE "group" SET id = $2 WHERE id = $1`, [id, target]);
    migrated++;
  }
}

for (const b of broken) {
  console.log(
    `BROKEN ${b.id}  (${b.members.length} members: ${b.members.join(", ")}, ` +
      `${b.messages} messages) — not a 1:1 pair, cannot be re-keyed`,
  );
  if (!(APPLY && PURGE)) continue;
  for (const { name } of TABLES) {
    await pool.query(`DELETE FROM ${name} WHERE group_id = $1`, [b.id]);
  }
  await pool.query(`DELETE FROM "group" WHERE id = $1`, [b.id]);
  console.log(`  deleted.`);
}

console.log(
  APPLY
    ? `done: ${migrated} re-keyed, ${merged} merged, ${broken.length} broken${
        PURGE ? " (purged)" : " (left in place; pass --purge-broken to delete)"
      }`
    : `dry run: pass --apply to write${
        broken.length ? " (and --purge-broken to delete the broken DMs)" : ""
      }`,
);
await pool.end();
