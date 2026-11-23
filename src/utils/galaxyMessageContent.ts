const EMPTY_FORM_MESSAGE = '[formulário enviado]';
const MAX_PARAMS_LENGTH = 16_384;
const MAX_FIELD_VALUE_LENGTH = 2_000;

/** Extract only the user-entered fields from a WhatsApp ad lead form. */
export const getGalaxyMessageContent = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_FORM_MESSAGE;

  const response = value as {
    body?: { text?: unknown };
    nativeFlowResponseMessage?: { name?: unknown; paramsJson?: unknown };
  };
  const flow = response.nativeFlowResponseMessage;
  if (
    flow?.name !== 'galaxy_message' ||
    typeof flow.paramsJson !== 'string' ||
    flow.paramsJson.length > MAX_PARAMS_LENGTH
  ) {
    return EMPTY_FORM_MESSAGE;
  }

  try {
    const params: unknown = JSON.parse(flow.paramsJson);
    if (!params || typeof params !== 'object' || Array.isArray(params)) return EMPTY_FORM_MESSAGE;

    const fields = Object.entries(params as Record<string, unknown>)
      .flatMap(([key, fieldValue]) => {
        const match = /^screen_(\d+)_(.+)_(\d+)$/.exec(key);
        if (!match || typeof fieldValue !== 'string') return [];
        const [, screenIndex, label, fieldIndex] = match;
        const trimmedLabel = label.trim();
        const trimmedValue = fieldValue.trim();
        if (!trimmedLabel || trimmedLabel.length > 100 || !trimmedValue) return [];
        return [
          {
            screenIndex: Number(screenIndex),
            fieldIndex: Number(fieldIndex),
            label: trimmedLabel,
            value: trimmedValue.slice(0, MAX_FIELD_VALUE_LENGTH),
          },
        ];
      })
      .sort((left, right) => left.screenIndex - right.screenIndex || left.fieldIndex - right.fieldIndex);

    if (fields.length === 0) return EMPTY_FORM_MESSAGE;

    const bodyText = typeof response.body?.text === 'string' ? response.body.text.trim() : '';
    return [bodyText, ...fields.map(({ label, value: fieldValue }) => `${label}: ${fieldValue}`)]
      .filter(Boolean)
      .join('\n');
  } catch {
    return EMPTY_FORM_MESSAGE;
  }
};

/** Keep the previously supported selection flows while giving galaxy forms their own contract. */
export const getInteractiveResponseContent = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const flow = (value as { nativeFlowResponseMessage?: { name?: unknown; paramsJson?: unknown } })
    .nativeFlowResponseMessage;
  if (flow?.name === 'galaxy_message') return getGalaxyMessageContent(value);
  if (flow?.name !== 'quick_reply' && flow?.name !== 'single_select') return undefined;
  if (typeof flow.paramsJson !== 'string' || flow.paramsJson.length > MAX_PARAMS_LENGTH) return undefined;

  try {
    const params: unknown = JSON.parse(flow.paramsJson);
    if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
    const id = (params as { id?: unknown }).id;
    if (typeof id !== 'string') return undefined;
    const text = id.trim();
    const hasControl = [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (!text || text.length > 1_024 || /^unknown$/i.test(text) || hasControl) return undefined;
    return text;
  } catch {
    return undefined;
  }
};
