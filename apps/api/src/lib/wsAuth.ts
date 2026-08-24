/** Prefer Authorization: Bearer so JWTs need not appear in request URLs. Query token is still accepted. */
export function extractWsAccessToken(input: {
  headers: { authorization?: string; Authorization?: string };
  query: unknown;
}): string | undefined {
  const header = input.headers.authorization ?? input.headers.Authorization;
  if (typeof header === "string") {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const query = input.query as { token?: unknown };
  return typeof query?.token === "string" && query.token.length > 0 ? query.token : undefined;
}
