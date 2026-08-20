import { auth } from "@/auth";
import {
  deleteMobilePushToken,
  saveMobilePushToken,
  type MobilePlatform,
} from "@/lib/db";

// Native push registration for the Capacitor shell — the mobile counterpart of
// /api/push/subscribe. The token is an APNs device token on iOS and an FCM
// registration token on Android; the platform decides which transport the
// server sends over (src/server/mobile-push.ts), so it travels with the token.
//
// Tokens rotate on their own, so the shell re-POSTs on every launch and this
// has to be idempotent (it is — the token is the primary key).

const PLATFORMS = new Set<string>(["ios", "android"]);
/** Both token formats are well under this; the cap just bounds the write. */
const MAX_TOKEN = 4096;

async function userId(): Promise<string | undefined> {
  const session = await auth();
  return (session?.user as { id?: string } | undefined)?.id;
}

export async function POST(req: Request) {
  const uid = await userId();
  if (!uid) return new Response("Unauthorized", { status: 401 });

  let body: { token?: unknown; platform?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  const { token, platform } = body;
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN) {
    return new Response("Missing token", { status: 400 });
  }
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
    return new Response("Bad platform", { status: 400 });
  }
  await saveMobilePushToken(uid, token, platform as MobilePlatform);
  return new Response(null, { status: 204 });
}

// Unregister (the user turned notifications off on that device). Body-carrying
// DELETE, matching the token-in-body shape of the POST above.
export async function DELETE(req: Request) {
  const uid = await userId();
  if (!uid) return new Response("Unauthorized", { status: 401 });

  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  if (typeof token !== "string" || !token) {
    return new Response("Missing token", { status: 400 });
  }
  // The token is globally unique per device, so deleting by it only ever drops
  // this device's own row — the same argument /api/push/unsubscribe makes.
  await deleteMobilePushToken(token);
  return new Response(null, { status: 204 });
}
