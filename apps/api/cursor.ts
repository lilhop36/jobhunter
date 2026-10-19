/**
 * Opaque pagination cursors, shared by the list endpoints.
 *
 * A cursor is the base64url of a keyset tuple, encoded as JSON rather than joined on a
 * delimiter so a value that contains the delimiter (a source name, say) cannot corrupt it.
 * Decoding returns whatever was parsed: each endpoint validates the shape it expects, because a
 * well-formed cursor belonging to another endpoint is still a bad request. The caller decides
 * the error — the client sent the cursor, so the client is told.
 */
export function encodeCursor(tuple: unknown): string {
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
