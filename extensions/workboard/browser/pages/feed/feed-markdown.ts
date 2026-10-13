import { html, nothing, type TemplateResult } from "lit";

// Agent text renders through Lit templates only: no HTML from card content reaches the DOM.
const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g;

function renderInline(text: string): Array<string | TemplateResult> {
  const parts: Array<string | TemplateResult> = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) {
      parts.push(text.slice(last, index));
    }
    if (token.startsWith("**")) {
      parts.push(html`<strong>${token.slice(2, -2)}</strong>`);
    } else if (token.startsWith("`")) {
      parts.push(html`<code>${token.slice(1, -1)}</code>`);
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      parts.push(
        html`<a href=${token.slice(split + 2, -1)} target="_blank" rel="noreferrer noopener"
          >${token.slice(1, split)}</a
        >`,
      );
    } else {
      parts.push(html`<a href=${token} target="_blank" rel="noreferrer noopener">${token}</a>`);
    }
    last = index + token.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

type Block = { kind: "p" | "ul" | "ol" | "h"; lines: string[] };

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (heading?.[1]) {
      blocks.push({ kind: "h", lines: [heading[1]] });
      current = null;
      continue;
    }
    const kind = bullet ? "ul" : ordered ? "ol" : "p";
    const content = bullet?.[1] ?? ordered?.[1] ?? line;
    if (!current || current.kind !== kind) {
      current = { kind, lines: [] };
      blocks.push(current);
    }
    current.lines.push(content);
  }
  return blocks;
}

export function renderFeedMarkdown(text: string | undefined): TemplateResult | typeof nothing {
  if (!text?.trim()) {
    return nothing;
  }
  return html`${toBlocks(text).map((block) => {
    if (block.kind === "ul") {
      return html`<ul>
        ${block.lines.map((line) => html`<li>${renderInline(line)}</li>`)}
      </ul>`;
    }
    if (block.kind === "ol") {
      return html`<ol>
        ${block.lines.map((line) => html`<li>${renderInline(line)}</li>`)}
      </ol>`;
    }
    if (block.kind === "h") {
      return html`<p class="wb-feed-md__heading">${renderInline(block.lines[0] ?? "")}</p>`;
    }
    return html`<p>
      ${block.lines.map(
        (line, index) => html`${index > 0 ? html`<br />` : nothing}${renderInline(line)}`,
      )}
    </p>`;
  })}`;
}
