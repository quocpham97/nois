"use client";

import EmojiPicker, { Theme, type EmojiClickData } from "emoji-picker-react";
import { useTheme } from "next-themes";

/**
 * Shared emoji picker (emoji-picker-react) used by the composer (insert) and the
 * message reaction picker (react). Themed to follow the app's light/dark mode;
 * the host controls positioning, this just renders the picker and reports picks.
 */
export function EmojiPickerPopup({
  onPick,
  height = 360,
}: {
  onPick: (emoji: string) => void;
  height?: number;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <EmojiPicker
      onEmojiClick={(data: EmojiClickData) => onPick(data.emoji)}
      theme={resolvedTheme === "dark" ? Theme.DARK : Theme.LIGHT}
      width="100%"
      height={height}
      lazyLoadEmojis
      skinTonesDisabled
      autoFocusSearch={false}
      previewConfig={{ showPreview: false }}
    />
  );
}
