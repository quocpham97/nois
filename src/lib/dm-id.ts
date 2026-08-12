import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The id of the 1:1 DM between two users — derived from *both* participants'
 * stable uids, so it is symmetric (each side computes the same id without
 * asking the server) and unique per pair.
 *
 * This must be pair-scoped, not peer-scoped: keying a DM by the recipient's
 * uid alone made every sender who messaged the same person land in one shared
 * thread (and made each client seal to whichever member it picked as "the
 * other one", so messages arrived undecryptable).
 *
 * The id is an opaque hash for the same reason group ids are — it goes in the
 * /<id> URL, which must not leak either participant's uid (a real user's uid is
 * their email). 20 hex chars, so a DM id can never collide with the 16-char
 * `newGroupId()` space.
 *
 * The NUL separator can't appear in a uid, so no two distinct pairs can hash the
 * same bytes. Changing the hashed string at all re-keys every existing DM, so
 * don't touch the format without a migration (see scripts/fix-dm-ids.mts).
 */
export function dmIdFor(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return bytesToHex(sha256(utf8ToBytes(`dm\u0000${x}\u0000${y}`))).slice(0, 20);
}
