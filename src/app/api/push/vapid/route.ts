// Hands the client the VAPID PUBLIC key to build a PushSubscription. Public by
// design (it's the applicationServerKey the browser embeds); a route (not a
// NEXT_PUBLIC_ env) so rotating keys needs no rebuild.
export async function GET() {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return new Response("Push not configured", { status: 503 });
  return Response.json({ publicKey: key });
}
