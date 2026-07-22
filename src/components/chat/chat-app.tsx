"use client";

import { ChatProvider, useChat } from "./chat-context";
import { SocketProvider } from "./socket-context";
import { CallProvider } from "./call-context";
import { CallUI } from "./call-view";
import { WorkspaceRail } from "./workspace-rail";
import { Sidebar } from "./sidebar";
import { ChannelView } from "./channel-view";
import { ChannelInfoPanel } from "./channel-info-panel";
import { SearchView } from "./search-view";
import { ComposeView } from "./compose-view";
import { SettingsView } from "./settings-view";
import { EmptyChatView } from "./empty-chat-view";
import { CreateChannelView } from "./create-channel-view";
import { WorkspaceView } from "./workspace-view";
import { ForwardModal } from "./forward-modal";
import { StatusModal } from "./status-modal";
import {
  RestoreKeysModal,
  BackupSetupModal,
  KeyChangeBanner,
  RecoveryWaitingBanner,
  DeviceApprovalModal,
} from "./key-backup";
import { MentionsView, DraftsView } from "./nav-views";
import { useMobileLayout } from "../mobile/use-mobile-layout";
import { MobileApp } from "../mobile/mobile-app";

function MainView() {
  const {
    composeOpen,
    settingsOpen,
    createChannelOpen,
    activePanel,
    channels,
    currentChannelId,
  } = useChat();

  if (composeOpen) return <ComposeView />;
  if (settingsOpen) return <SettingsView />;
  if (createChannelOpen) return <CreateChannelView />;
  if (activePanel === "mentions") return <MentionsView />;
  if (activePanel === "drafts") return <DraftsView />;
  // "people" / "archived" take over the sidebar column (see Sidebar), leaving
  // the main area to show the open conversation or the empty state.
  const ch = channels[currentChannelId];
  if (!ch) return <EmptyChatView />;
  return <ChannelView ch={ch} />;
}

function Shell() {
  const {
    channelInfoOpen,
    searchOpen,
    composeOpen,
    settingsOpen,
    createChannelOpen,
    workspaceOpen,
    statusOpen,
    activePanel,
  } = useChat();
  // The channel view is what's showing when no full-pane view has taken over
  // (search is a modal overlay now, so it doesn't count).
  const channelActive =
    !composeOpen &&
    !settingsOpen &&
    !createChannelOpen &&
    !workspaceOpen &&
    !activePanel;
  return (
    <div className="flex h-screen w-full overflow-hidden bg-app-bg text-[15px] text-app-text">
      <WorkspaceRail />
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-app-bg">
        <KeyChangeBanner />
        <RecoveryWaitingBanner />
        <MainView />
      </main>
      {channelInfoOpen && channelActive && <ChannelInfoPanel />}
      {workspaceOpen && <WorkspaceView />}
      {searchOpen && <SearchView />}
      <ForwardModal />
      {statusOpen && <StatusModal />}
      <RestoreKeysModal />
      <BackupSetupModal />
      <DeviceApprovalModal />
      <CallUI />
    </div>
  );
}

// Picks the phone-optimized screen set or the desktop shell. Lives INSIDE the
// providers so both consume the same live Socket/Chat/Call state — switching
// layout (e.g. rotating a tablet across the breakpoint) never remounts them.
function RootShell() {
  const mobile = useMobileLayout();
  return mobile ? <MobileApp /> : <Shell />;
}

export function ChatApp({ meId, meName }: { meId: string; meName?: string }) {
  return (
    <SocketProvider meId={meId} meName={meName}>
      <ChatProvider>
        <CallProvider>
          <RootShell />
        </CallProvider>
      </ChatProvider>
    </SocketProvider>
  );
}
