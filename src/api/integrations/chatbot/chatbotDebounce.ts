/**
 * Debounce de mensagens de entrada dos chatbots.
 *
 * XMACNA_DEBOUNCE_DETACHED_518 — mudanca de contrato em relacao ao upstream e a
 * `xmacna/2.3.7-durable-inbox`:
 *
 * Antes, esta funcao devolvia uma Promise que so resolvia no flush do timer.
 * O sink duravel `chatbot` do inbox (#500) faz `await` dessa Promise dentro da
 * fila serial por instancia do `BaileysMessageProcessor`, entao cada mensagem
 * prendia a instancia por `debounceTime + tempo do workflow n8n` e a mensagem
 * seguinte do mesmo lead so entrava depois que o buffer da anterior ja tinha
 * fechado — ou seja, o debounce nunca coalescia na rota Baileys (#518).
 *
 * Agora a chamada devolve SINCRONAMENTE um recibo de ACEITACAO no buffer. O
 * flush (POST ao n8n + resposta ao WhatsApp) roda destacado do chamador, com
 * log proprio de falha. Quem quiser observar o flush (testes, diagnostico) usa
 * `acceptance.flushed`.
 *
 * Consequencia de garantia, deliberada e registrada em #518/#500: entre a
 * aceitacao no buffer e o flush a mensagem vive apenas em memoria. Se o
 * processo cair nessa janela, o recibo duravel ja marcou o sink `chatbot` como
 * entregue e nao havera replay. E exatamente o mesmo risco do upstream (que
 * chamava o emit sem await), agora consciente e documentado. A alternativa
 * at-least-once estrita seria persistir o proprio buffer no recibo; ficou como
 * nota, nao como padrao.
 */

export type ChatbotDebounceMetadata = {
  /** Quantas mensagens do lead foram coalescidas neste buffer. */
  messageCount: number;
  /** `messageTimestamp` (epoch em segundos) da primeira mensagem do buffer. */
  firstMessageTimestamp?: number;
  /** `messageTimestamp` (epoch em segundos) da ultima mensagem do buffer. */
  lastMessageTimestamp?: number;
};

export type ChatbotDebounceCallback = (content: string, metadata: ChatbotDebounceMetadata) => Promise<void>;

type ChatbotDebounceEntry = {
  message: string;
  timeoutId: NodeJS.Timeout | null;
  callback: ChatbotDebounceCallback;
  metadata: ChatbotDebounceMetadata;
  flushed: Promise<void>;
  resolveFlushed: () => void;
  rejectFlushed: (error: unknown) => void;
};

export type ChatbotDebounceStore = Record<string, ChatbotDebounceEntry>;

export type ChatbotDebounceOptions = {
  /** `messageTimestamp` normalizado da mensagem que esta sendo aceita. */
  messageTimestamp?: unknown;
  onMerged?: (content: string) => void;
  onFlushed?: (content: string) => void;
  /** Unico lugar onde uma falha do flush destacado fica visivel. */
  onFlushError?: (error: unknown) => void;
};

export type ChatbotDebounceAcceptance = {
  /** `true` quando a mensagem entrou num buffer que ja existia. */
  merged: boolean;
  /** Snapshot dos metadados no instante da aceitacao. */
  metadata: ChatbotDebounceMetadata;
  /**
   * Resolve quando o flush deste buffer terminou; rejeita com o erro do
   * callback. NAO deve ser aguardada no caminho de entrega da instancia — o
   * ponto do #518 e justamente nao bloquear a fila. Existe para teste e
   * diagnostico. Ja vem com um `catch` interno, entao ignora-la nunca vira
   * `unhandledRejection`.
   */
  flushed: Promise<void>;
};

export function buildChatbotDebounceKey(instanceName: string, remoteJid: string): string {
  return JSON.stringify([instanceName, remoteJid]);
}

/**
 * O `messageTimestamp` do Baileys chega como number, string ou Long. Só
 * aceitamos o que vira um numero finito; qualquer outra coisa fica `undefined`
 * em vez de virar `NaN` no payload do n8n.
 */
export function normalizeMessageTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function processChatbotDebounce(
  store: ChatbotDebounceStore,
  content: string,
  debounceKey: string,
  debounceTime: number,
  callback: ChatbotDebounceCallback,
  options: ChatbotDebounceOptions = {},
): ChatbotDebounceAcceptance {
  const timestamp = normalizeMessageTimestamp(options.messageTimestamp);
  const existing = store[debounceKey];
  const merged = Boolean(existing);
  let entry: ChatbotDebounceEntry;

  if (existing) {
    existing.message += `\n${content}`;
    existing.callback = callback;
    existing.metadata.messageCount += 1;
    if (timestamp !== undefined) {
      if (existing.metadata.firstMessageTimestamp === undefined) {
        existing.metadata.firstMessageTimestamp = timestamp;
      }
      existing.metadata.lastMessageTimestamp = timestamp;
    }
    options.onMerged?.(existing.message);
    if (existing.timeoutId) clearTimeout(existing.timeoutId);
    entry = existing;
  } else {
    let resolveFlushed!: () => void;
    let rejectFlushed!: (error: unknown) => void;
    const flushed = new Promise<void>((resolve, reject) => {
      resolveFlushed = resolve;
      rejectFlushed = reject;
    });
    // O chamador nao e obrigado a observar o flush; sem este catch uma falha do
    // POST ao n8n derrubaria o processo por unhandledRejection.
    flushed.catch(() => undefined);
    entry = {
      message: content,
      timeoutId: null,
      callback,
      metadata: {
        messageCount: 1,
        firstMessageTimestamp: timestamp,
        lastMessageTimestamp: timestamp,
      },
      flushed,
      resolveFlushed,
      rejectFlushed,
    };
    store[debounceKey] = entry;
  }

  const scheduled = entry;
  scheduled.timeoutId = setTimeout(() => {
    // Um flush so pode consumir o buffer que ele agendou. Sem esta guarda, um
    // timer antigo poderia despachar um ciclo novo criado depois do delete.
    if (store[debounceKey] !== scheduled) return;
    delete store[debounceKey];
    options.onFlushed?.(scheduled.message);
    const snapshot: ChatbotDebounceMetadata = { ...scheduled.metadata };
    void Promise.resolve()
      .then(() => scheduled.callback(scheduled.message, snapshot))
      .then(
        () => scheduled.resolveFlushed(),
        (error) => {
          options.onFlushError?.(error);
          scheduled.rejectFlushed(error);
        },
      );
  }, debounceTime * 1000);

  return { merged, metadata: { ...scheduled.metadata }, flushed: scheduled.flushed };
}
