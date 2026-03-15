import type { FindResultItem } from "./types.js";

export function formatFindItems(items: FindResultItem[]): string {
  return items
    .map((item) => {
      const score = typeof item.score === "number" ? ` (${Math.round(item.score * 100)}%)` : "";
      const summary = item.abstract || item.overview || item.uri;
      return `- ${item.uri}${score}\n  ${summary}`;
    })
    .join("\n");
}

export function wrapContextBlock(tag: string, title: string, body: string): string {
  return `<${tag}>\n${title}\n${body.trim()}\n</${tag}>`;
}

export function summarizeContextItems(items: FindResultItem[], heading: string): string | null {
  if (items.length === 0) {
    return null;
  }
  return `${heading}\n${formatFindItems(items)}`;
}
