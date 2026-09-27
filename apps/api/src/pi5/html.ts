const HEAVY_BLOCK =
  /<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Drop script, style, and embedded media wrappers before markdown conversion. */
export function stripHeavyHtml(html: string): string {
  return html
    .replace(HEAVY_BLOCK, " ")
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*\/>/gi, " ");
}

export function visibleTextLength(html: string): number {
  const text = stripHeavyHtml(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

export function isThinHtml(html: string | undefined, threshold: number): boolean {
  if (!html) {
    return true;
  }
  return visibleTextLength(html) < threshold;
}
