import { auth } from "@/auth";
import { deletePushSubscription } from "@/lib/db";

// Remove a push subscription (user disabled notifications on this device).
export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let endpoint: string | undefined;
  try {
    endpoint = (await req.json())?.endpoint;
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  if (!endpoint) return new Response("Missing endpoint", { status: 400 });
  // Endpoint is the PK, globally unique per browser — deleting by it only ever
  // removes this device's own row.
  await deletePushSubscription(endpoint);
  return new Response(null, { status: 204 });
}
