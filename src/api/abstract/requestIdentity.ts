/** Route params are authenticated identity; query values may never override them. */
export function mergeRequestIdentity(
  params: Record<string, unknown>,
  query?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(query || {}), ...params };
}
