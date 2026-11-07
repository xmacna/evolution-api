/** xmacna/elysium#1061: selection values only; never serialize native-flow metadata.
 * Supported native-flow variants: quick_reply and single_select with a string id.
 * Other flows (forms, payments, permissions) need their own semantic contract.
 */
export const getInteractiveResponseContent = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const response = value as { nativeFlowResponseMessage?: { name?: unknown; paramsJson?: unknown } };
  const flow = response.nativeFlowResponseMessage;
  if (!flow || (flow.name !== 'quick_reply' && flow.name !== 'single_select')) return undefined;
  if (typeof flow.paramsJson !== 'string' || flow.paramsJson.length > 16384) return undefined;

  try {
    const params: unknown = JSON.parse(flow.paramsJson);
    if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(params, 'id')) return undefined;
    const id = (params as { id?: unknown }).id;
    if (typeof id !== 'string') return undefined;
    const text = id.trim();
    const hasControl = [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (!text || text.length > 1024 || /^unknown$/i.test(text) || hasControl) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
};
