"use client";

import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";
import { ChatProvider } from "./chat-provider";
import { SessionProvider } from "./session-provider";
import { CallProvider } from "./call-provider";
import { CallUI } from "./call-view";
import { WorkspaceRail } from "./workspace-rail";
import { Sidebar } from "./sidebar";
import { GroupView } from "./group-view";
import { GroupInfoPanel } from "./group-info-panel";
import { SearchView } from "./search-view";
import { ComposeView } from "./compose-view";
import { SettingsView } from "./settings-view";
import { EmptyChatView } from "./empty-chat-view";
import { NewChatView } from "./new-chat-view";
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
  const { composeOpen, settingsOpen, newChatOpen, activePanel, groupId } =
    useChatStore(
      useShallow((s) => ({
        composeOpen: s.composeOpen,
        settingsOpen: s.settingsOpen,
        newChatOpen: s.newChatOpen,
        activePanel: s.activePanel,
        // The id only — GroupView subscribes to the conversation itself, so a
        // new message doesn't re-render this switch.
        groupId: s.groups[s.currentGroupId] ? s.currentGroupId : "",
      })),
    );

  if (composeOpen) return <ComposeView />;
  if (settingsOpen) return <SettingsView />;
  if (newChatOpen) return <NewChatView />;
  if (activePanel === "mentions") return <MentionsView />;
  if (activePanel === "drafts") return <DraftsView />;
  // "people" / "archived" take over the sidebar column (see Sidebar), leaving
  // the main area to show the open conversation or the empty state.
  if (!groupId) return <EmptyChatView />;
  return <GroupView groupId={groupId} />;
}

function Shell() {
  const {
    groupInfoOpen,
    searchOpen,
    composeOpen,
    settingsOpen,
    newChatOpen,
    workspaceOpen,
    statusOpen,
    activePanel,
  } = useChatStore(
    useShallow((s) => ({
      groupInfoOpen: s.groupInfoOpen,
      searchOpen: s.searchOpen,
      composeOpen: s.composeOpen,
      settingsOpen: s.settingsOpen,
      newChatOpen: s.newChatOpen,
      workspaceOpen: s.workspaceOpen,
      statusOpen: s.statusOpen,
      activePanel: s.activePanel,
    })),
  );
  // The group view is what's showing when no full-pane view has taken over
  // (search is a modal overlay now, so it doesn't count).
  const groupActive =
    !composeOpen &&
    !settingsOpen &&
    !newChatOpen &&
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
      {groupInfoOpen && groupActive && <GroupInfoPanel />}
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
    <SessionProvider meId={meId} meName={meName}>
      <ChatProvider>
        <CallProvider>
          <RootShell />
        </CallProvider>
      </ChatProvider>
    </SessionProvider>
  );
}
