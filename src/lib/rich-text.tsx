import type { ReactNode } from "react";

// Lightweight message formatting: inline markdown (code, bold, italic, strike,
// links) + @mentions, with line-based blockquote/list support. Intentionally
// minimal — no external markdown dependency. Mention names are supplied per
// message (the server-derived `mentions` list) rather than a static directory.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Longest names first so "James O'Brien" matches before a shorter prefix.
function mentionAlternation(names: string[]): string {
  return [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
}

function inlineRe(mentionNames: string): RegExp {
  const parts = [
    "(`[^`]+`)", // 1 inline code
    "(\\*\\*[^*]+\\*\\*)", // 2 bold
    "(~~[^~]+~~)", // 3 strike
    "(\\*[^*\\n]+\\*)", // 4 italic *
    "(_[^_\\n]+_)", // 5 italic _
    "(\\[[^\\]]+\\]\\([^)\\s]+\\))", // 6 link [text](url)
  ];
  if (mentionNames) parts.push("(@(?:" + mentionNames + "))"); // 7 mention
  return new RegExp(parts.join("|"), "g");
}

type InlineCtx = { selfName?: string; mentionNames: string; k: { n: number } };

function inline(text: string, ctx: InlineCtx): ReactNode[] {
  const { selfName } = ctx;
  const k = ctx.k;
  const out: ReactNode[] = [];
  const re = inlineRe(ctx.mentionNames);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [full, code, bold, strike, ital1, ital2, link, mention] = m;
    if (code) {
      out.push(
        <code
          key={k.n++}
          className="rounded bg-panel px-1 py-px font-mono text-[12.5px]"
        >
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      out.push(<strong key={k.n++}>{inline(bold.slice(2, -2), ctx)}</strong>);
    } else if (strike) {
      out.push(
        <span key={k.n++} className="line-through">
          {inline(strike.slice(2, -2), ctx)}
        </span>,
      );
    } else if (ital1 || ital2) {
      const inner = (ital1 || ital2).slice(1, -1);
      out.push(<em key={k.n++}>{inline(inner, ctx)}</em>);
    } else if (link) {
      const mm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(link)!;
      out.push(
        <a
          key={k.n++}
          href={mm[2]}
          target="_blank"
          rel="noreferrer"
          className="text-app-accent underline hover:no-underline"
        >
          {mm[1]}
        </a>,
      );
    } else if (mention) {
      const isSelf = selfName && mention === "@" + selfName;
      out.push(
        <span
          key={k.n++}
          className="rounded px-[5px] py-px font-medium"
          style={{
            background: isSelf ? "oklch(0.95 0.08 80)" : "var(--app-accent-soft)",
            color: isSelf ? "oklch(0.40 0.18 60)" : "var(--app-accent)",
          }}
        >
          {mention}
        </span>,
      );
    }
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderRichText(
  text: string,
  opts?: { selfName?: string; mentions?: string[] },
): ReactNode {
  const ctx: InlineCtx = {
    selfName: opts?.selfName,
    mentionNames: mentionAlternation(opts?.mentions ?? []),
    k: { n: 0 },
  };
  const k = ctx.k;
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (/^>\s?/.test(line)) {
      blocks.push(
        <span
          key={k.n++}
          className="my-0.5 block border-l-2 border-app-border pl-2 text-app-muted"
        >
          {inline(line.replace(/^>\s?/, ""), ctx)}
        </span>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push(
        <span key={k.n++} className="flex gap-1.5">
          <span className="text-app-faint">•</span>
          <span>{inline(line.replace(/^[-*]\s+/, ""), ctx)}</span>
        </span>,
      );
    } else {
      blocks.push(<span key={k.n++}>{inline(line, ctx)}</span>);
      if (i < lines.length - 1) blocks.push(<br key={k.n++} />);
    }
  });
  return <>{blocks}</>;
}
