export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Cuts `text` down to at most `maxBytes` (UTF-8 encoded) and appends a
 * human-readable notice so callers never silently lose data without a hint.
 */
export function truncateText(text: string, maxBytes: number): TruncateResult {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false, originalBytes: buf.length };
  }
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return {
    text: `${sliced}\n\n[gekürzt: ${maxBytes} von ${buf.length} Bytes angezeigt]`,
    truncated: true,
    originalBytes: buf.length,
  };
}
