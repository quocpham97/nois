import { auth } from "@/auth";
import { savePushSubscription } from "@/lib/db";

// Persist a browser PushSubscription for the signed-in user. Body is the
// output of PushSubscription.toJSON() ({ endpoint, keys: { p256dh, auth } }).
export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return new Response("Missing subscription", { status: 400 });
  }
  await savePushSubscription(
    userId,
    endpoint,
    { p256dh: keys.p256dh, auth: keys.auth },
    req.headers.get("user-agent") ?? undefined,
  );
  return new Response(null, { status: 204 });
}
