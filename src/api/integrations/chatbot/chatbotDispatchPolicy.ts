export type BestEffortChatbot = {
  name: string;
  emit: () => Promise<void>;
};

export async function runBestEffortChatbots(
  chatbots: BestEffortChatbot[],
  onFailure: (name: string, error: Error) => void,
): Promise<void> {
  const outcomes = await Promise.allSettled(chatbots.map(({ emit }) => emit()));
  outcomes.forEach((outcome, index) => {
    if (outcome.status !== 'rejected') return;
    const error = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
    onFailure(chatbots[index].name, error);
  });
}
