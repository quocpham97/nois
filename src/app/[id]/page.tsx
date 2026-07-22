import { ChatGate } from "@/components/chat/chat-gate";

// Conversation route: /<id> for both groups and DMs (ch.type distinguishes
// them). More specific static routes (/settings, /drafts, …) take precedence.
// The active conversation is read from the URL by ChatProvider.
export default function ConversationPage() {
  return <ChatGate />;
}
