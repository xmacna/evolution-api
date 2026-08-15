export type ChatbotDebounceCallback = (content: string) => Promise<void>;

type DebounceWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ChatbotDebounceEntry = {
  message: string;
  timeoutId: NodeJS.Timeout | null;
  callback: ChatbotDebounceCallback;
  waiters: DebounceWaiter[];
};

export type ChatbotDebounceStore = Record<string, ChatbotDebounceEntry>;

export function buildChatbotDebounceKey(instanceName: string, remoteJid: string): string {
  return JSON.stringify([instanceName, remoteJid]);
}

export function processChatbotDebounce(
  store: ChatbotDebounceStore,
  content: string,
  debounceKey: string,
  debounceTime: number,
  callback: ChatbotDebounceCallback,
  onMerged?: (content: string) => void,
  onFlushed?: (content: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const current = store[debounceKey];
    if (current) {
      current.message += `\n${content}`;
      current.waiters.push({ resolve, reject });
      current.callback = callback;
      onMerged?.(current.message);
      if (current.timeoutId) clearTimeout(current.timeoutId);
    } else {
      store[debounceKey] = {
        message: content,
        timeoutId: null,
        callback,
        waiters: [{ resolve, reject }],
      };
    }

    store[debounceKey].timeoutId = setTimeout(async () => {
      const entry = store[debounceKey];
      delete store[debounceKey];
      onFlushed?.(entry.message);
      try {
        await entry.callback(entry.message);
        entry.waiters.forEach((waiter) => waiter.resolve());
      } catch (error) {
        entry.waiters.forEach((waiter) => waiter.reject(error));
      }
    }, debounceTime * 1000);
  });
}
