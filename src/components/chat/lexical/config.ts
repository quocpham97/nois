import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { QuoteNode } from "@lexical/rich-text";
import type { Klass, LexicalNode } from "lexical";
import { MentionNode } from "./MentionNode";

// Shared between the live composer and the headless renderer so editor-state
// JSON round-trips (every custom node must be registered in both).
export const EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  ListNode,
  ListItemNode,
  LinkNode,
  QuoteNode,
  MentionNode,
];

export const EDITOR_THEME = {
  text: {
    bold: "font-semibold",
    italic: "italic",
    strikethrough: "line-through",
    code: "lex-code",
  },
  list: {
    ul: "lex-ul",
    ol: "lex-ol",
    listitem: "lex-li",
  },
  quote: "lex-quote",
  link: "lex-link",
  paragraph: "lex-p",
};
