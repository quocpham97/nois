import { createHeadlessEditor } from "@lexical/headless";
import { $generateHtmlFromNodes } from "@lexical/html";
import { EDITOR_NODES, EDITOR_THEME } from "@/components/chat/lexical/config";

// Convert a stored Lexical editor-state JSON string to HTML, once per unique
// content (memoized). Runs client-side, where document is available for the
// nodes' DOM export. Falls back to empty string on parse errors.
const cache = new Map<string, string>();

export function richToHtml(richJson: string): string {
  // The node DOM export needs `document`; rich messages only render client-side.
  if (typeof document === "undefined") return "";
  const hit = cache.get(richJson);
  if (hit !== undefined) return hit;

  let html = "";
  try {
    const editor = createHeadlessEditor({
      namespace: "render",
      nodes: [...EDITOR_NODES],
      theme: EDITOR_THEME,
      onError: () => {},
    });
    editor.setEditorState(editor.parseEditorState(richJson));
    editor.read(() => {
      html = $generateHtmlFromNodes(editor, null);
    });
  } catch {
    html = "";
  }
  cache.set(richJson, html);
  return html;
}
