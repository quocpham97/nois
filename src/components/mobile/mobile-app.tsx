"use client";

import { useMemo, useState } from "react";
import { ComposeView } from "../chat/compose-view";
import { SettingsView } from "../chat/settings-view";
import { MentionsView, DraftsView } from "../chat/nav-views";
import { ForwardModal } from "../chat/forward-modal";
import { StatusModal } from "../chat/status-modal";
import {
  RestoreKeysModal,
  BackupSetupModal,
  DeviceApprovalModal,
} from "../chat/key-backup";
import { CallUI } from "../chat/call-view";
import { ChatsScreen } from "./chats-screen";
import { ConversationScreen } from "./conversation-screen";
import { PeopleScreen } from "./people-screen";
import { CallsScreen } from "./calls-screen";
import { ProfileScreen } from "./profile-screen";
import { TabBar, type MobileTab } from "./tab-bar";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";

// Phone-optimized shell — the mobile counterpart of desktop Shell(), rendered
// by ChatApp/RootShell when the layout is mobile. It reuses the same providers,
// so every screen reads live state. Navigation model:
//   - full-screen takeovers (compose, settings, mentions/drafts deep-links) win
//   - an open conversation (currentGroupId) shows full-screen, tab bar hidden
//   - otherwise the active bottom-tab screen shows with the tab bar
// Global overlays (calls, forward, status, E2EE key modals) mount once at the
// root so incoming calls and key prompts surface regardless of the tab.
export function MobileApp() {
  const {
    groups,
    currentGroupId,
    composeOpen,
    settingsOpen,
    activePanel,
    statusOpen,
    unreadByGroup,
  } = useChatStore(
    useShallow((s) => ({
      groups: s.groups,
      currentGroupId: s.currentGroupId,
      composeOpen: s.composeOpen,
      settingsOpen: s.settingsOpen,
      activePanel: s.activePanel,
      statusOpen: s.statusOpen,
      unreadByGroup: s.unreadByGroup,
    })),
  );
  const [tab, setTab] = useState<MobileTab>("chats");

  const unreadCount = useMemo(
    () => Object.values(unreadByGroup).filter((n) => n > 0).length,
    [unreadByGroup],
  );

  const openGroup = groups[currentGroupId];

  const overlays = (
    <>
      <ForwardModal />
      {statusOpen && <StatusModal />}
      <RestoreKeysModal />
      <BackupSetupModal />
      <DeviceApprovalModal />
      <CallUI />
    </>
  );

  // Full-screen takeovers (their own headers/close controls).
  let body: React.ReactNode;
  let showTabbar = true;
  if (composeOpen) {
    body = <ComposeView />;
    showTabbar = false;
  } else if (settingsOpen) {
    body = <SettingsView />;
    showTabbar = false;
  } else if (activePanel === "mentions") {
    body = <MentionsView />;
    showTabbar = false;
  } else if (activePanel === "drafts") {
    body = <DraftsView />;
    showTabbar = false;
  } else if (openGroup) {
    body = <ConversationScreen ch={openGroup} />;
    showTabbar = false;
  } else if (tab === "people") {
    body = <PeopleScreen />;
  } else if (tab === "calls") {
    body = <CallsScreen />;
  } else if (tab === "profile") {
    body = <ProfileScreen />;
  } else {
    body = <ChatsScreen />;
  }

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-app-bg text-[15px] text-app-text">
      <div className="min-h-0 flex-1">{body}</div>
      {showTabbar && (
        <TabBar active={tab} onSelect={setTab} unreadCount={unreadCount} />
      )}
      {overlays}
    </div>
  );
}
