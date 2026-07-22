import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const tables = ["message", "reaction", "pin", "read_cursor"];
async function counts(label: string) {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = r.rows[0].n;
  }
  console.log(label, JSON.stringify(out));
}
await counts("BEFORE");
if (process.argv.includes("--delete")) {
  for (const t of tables) await pool.query(`DELETE FROM ${t}`);
  await counts("AFTER ");
}
await pool.end();
