import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ChatApp } from "@/components/chat/chat-app";

// Shared auth guard + app mount for every chat route (/, /[id], and the
// nav-panel + settings paths). The selected conversation — group or DM — is
// driven by the URL inside ChatProvider, so these routes all render the same
// app; only the path differs.
export async function ChatGate() {
  const session = await auth();
  const meId = (session?.user as { id?: string } | undefined)?.id;
  if (!meId) redirect("/login");
  return <ChatApp meId={meId} meName={session?.user?.name ?? undefined} />;
}
