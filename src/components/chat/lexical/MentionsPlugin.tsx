"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import * as ReactDOM from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, type TextNode } from "lexical";
import { type User } from "@/lib/chat-data";
import { $createMentionNode } from "./MentionNode";
import { useChatStore } from "@/stores/chat-store";

class MentionOption extends MenuOption {
  user: User;
  constructor(user: User) {
    super(user.name);
    this.user = user;
  }
}

// The menu list. Lives inside the plugin's caret-anchored element; positioned
// to open upward (the composer sits at the bottom of the screen) and
// auto-highlights the first option so Enter selects it.
function MentionMenu({
  options,
  selectedIndex,
  setHighlightedIndex,
  selectOptionAndCleanUp,
  openRef,
}: {
  options: MentionOption[];
  selectedIndex: number | null;
  setHighlightedIndex: (i: number) => void;
  selectOptionAndCleanUp: (o: MentionOption) => void;
  openRef: MutableRefObject<boolean>;
}) {
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, [openRef]);

  useEffect(() => {
    if (selectedIndex == null && options.length) setHighlightedIndex(0);
  }, [options, selectedIndex, setHighlightedIndex]);

  return (
    <div
      className="w-60 overflow-hidden rounded-lg border border-app-border bg-panel-2 py-1 shadow-[var(--app-shadow-lg)]"
      style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6 }}
    >
      {options.map((option, i) => (
        <button
          key={option.key}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setHighlightedIndex(i)}
          onClick={() => {
            setHighlightedIndex(i);
            selectOptionAndCleanUp(option);
          }}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
          style={{
            background: i === selectedIndex ? "var(--panel-hover)" : "transparent",
          }}
        >
          <span
            className="flex size-6 items-center justify-center rounded text-[10px] font-semibold text-white"
            style={{ background: option.user.bg }}
          >
            {option.user.initials}
          </span>
          <span className="text-[13px] font-medium">{option.user.name}</span>
        </button>
      ))}
    </div>
  );
}

export function MentionsPlugin({
  openRef,
}: {
  openRef: MutableRefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const workspaceMembers = useChatStore((s) => s.workspaceMembers);

  const triggerFn = useBasicTypeaheadTriggerMatch("@", { minLength: 0 });

  const options = useMemo(() => {
    const q = (query ?? "").toLowerCase();
    return workspaceMembers
      .filter((u) => u.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((u) => new MentionOption(u));
  }, [query, workspaceMembers]);

  const onSelect = useCallback(
    (
      option: MentionOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        const mention = $createMentionNode(option.user.name);
        if (nodeToReplace) nodeToReplace.replace(mention);
        const space = $createTextNode(" ");
        mention.insertAfter(space);
        space.select();
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      onQueryChange={setQuery}
      onSelectOption={onSelect}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(
        anchorRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) =>
        anchorRef.current && options.length
          ? ReactDOM.createPortal(
              <MentionMenu
                options={options}
                selectedIndex={selectedIndex}
                setHighlightedIndex={setHighlightedIndex}
                selectOptionAndCleanUp={selectOptionAndCleanUp}
                openRef={openRef}
              />,
              anchorRef.current,
            )
          : null
      }
    />
  );
}
