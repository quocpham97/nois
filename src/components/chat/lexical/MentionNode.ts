import {
  $applyNodeReplacement,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from "lexical";

// A mention is an atomic ("token") text node that renders highlighted and
// serializes to "@Name" in plain text — so the stored plaintext + the existing
// markdown renderer keep working.
export type SerializedMentionNode = Spread<
  { mentionName: string },
  SerializedTextNode
>;

export class MentionNode extends TextNode {
  __mention: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mention, node.__text, node.__key);
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode(json.mentionName);
  }

  constructor(mentionName: string, text?: string, key?: NodeKey) {
    super(text ?? "@" + mentionName, key);
    this.__mention = mentionName;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "mention",
      mentionName: this.__mention,
      version: 1,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = "mention";
    return dom;
  }

  exportDOM(): DOMExportOutput {
    const el = document.createElement("span");
    el.className = "mention";
    el.setAttribute("data-mention", this.__mention);
    el.textContent = this.__text;
    return { element: el };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (node: HTMLElement) =>
        node.classList.contains("mention")
          ? { conversion: convertMentionElement, priority: 1 }
          : null,
    };
  }

  isTextEntity(): true {
    return true;
  }
}

function convertMentionElement(el: HTMLElement): DOMConversionOutput {
  const name = el.getAttribute("data-mention") || el.textContent?.replace(/^@/, "") || "";
  return { node: $createMentionNode(name) };
}

export function $createMentionNode(mentionName: string): MentionNode {
  const node = new MentionNode(mentionName);
  node.setMode("token").toggleDirectionless();
  return $applyNodeReplacement(node);
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}
