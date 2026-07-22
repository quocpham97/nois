import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DesktopReturn } from "./desktop-return";

// Landing page after the system-browser leg of the desktop login handoff.
// Auth-gated like ChatGate: if the browser somehow isn't signed in yet, bounce
// back to /login carrying the desktop params so the flow restarts intact.
export default async function DesktopReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ challenge?: string }>;
}) {
  const { challenge } = await searchParams;
  if (!challenge) redirect("/login");
  const session = await auth();
  const meId = (session?.user as { id?: string } | undefined)?.id;
  if (!meId) {
    redirect(`/login?desktop=1&challenge=${encodeURIComponent(challenge)}`);
  }
  return <DesktopReturn challenge={challenge} />;
}
