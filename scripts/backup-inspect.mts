// Fetch a user's encrypted key-backup blob from Postgres and decrypt it with a
// PIN, replicating crypto/backup.ts (PBKDF2-SHA256 -> AES-256-GCM). Proves what
// the backup actually contains. Run:
//   npx tsx --env-file=.env.local scripts/backup-inspect.mts <userId> <pin>

import { getPool } from "../src/lib/db.ts";

const UID = process.argv[2] || "wuewue17@gmail.com";
const PIN = process.argv[3] || "12341234";
const te = new TextEncoder();
const td = new TextDecoder();
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

async function main() {
  const pool = getPool();
  const r = await pool.query("SELECT blob FROM key_backup WHERE user_id=$1", [UID]);
  if (!r.rows.length) { console.log("NO BACKUP ROW"); await pool.end(); return; }
  const blob = r.rows[0].blob as {
    v: number; iters: number; salt: string; iv: string; ct: string;
  };

  const base = await crypto.subtle.importKey("raw", te.encode(PIN), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(blob.salt), iterations: blob.iters, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  const data = JSON.parse(td.decode(pt)) as {
    keys?: unknown; messages?: { id: string; conv_id: string | null; data: string }[];
  };

  const msgs = data.messages ?? [];
  const marker = msgs.find((m) => m.data.includes("E2EE-BACKUP-PROOF"));
  console.log("blob.v            :", blob.v);
  console.log("has .keys         :", !!data.keys);
  console.log("message count     :", msgs.length);
  console.log("marker present    :", !!marker);
  if (marker) console.log("marker row        :", marker.conv_id, "-", JSON.parse(marker.data).text);
  console.log("sample texts      :", msgs.slice(0, 8).map((m) => { try { return JSON.parse(m.data).text; } catch { return "?"; } }));
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
