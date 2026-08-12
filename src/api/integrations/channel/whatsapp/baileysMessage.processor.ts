import { Logger } from '@config/logger.config';
import { BaileysEventMap } from 'baileys';

type MessageUpsertPayload = BaileysEventMap['messages.upsert'];
type MessageHandler = (payload: MessageUpsertPayload, settings: any) => Promise<void>;
type MountProps = { onMessageReceive: MessageHandler };

export class BaileysMessageProcessor {
  private readonly processorLogs = new Logger('BaileysMessageProcessor');
  private onMessageReceive?: MessageHandler;
  private queue: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    private readonly retryDelayMs = 1000,
    private readonly maxRetries = 3,
  ) {}

  mount({ onMessageReceive }: MountProps) {
    this.onMessageReceive = onMessageReceive;
    this.destroyed = false;
  }

  processMessage(payload: MessageUpsertPayload, settings: any): Promise<void> {
    if (!this.onMessageReceive || this.destroyed) {
      return Promise.reject(new Error('BaileysMessageProcessor is not mounted'));
    }
    this.queue = this.queue
      .catch((error) => {
        this.processorLogs.error(`Recovering message queue after unexpected error: ${error}`);
      })
      .then(() => this.processBatch(payload, settings));
    return this.queue;
  }

  private async processBatch(payload: MessageUpsertPayload, settings: any): Promise<void> {
    this.processorLogs.log(`Processing batch of ${payload.messages.length} messages`);
    for (const message of payload.messages) {
      await this.processOne({ ...payload, messages: [message] }, settings);
    }
  }

  private async processOne(payload: MessageUpsertPayload, settings: any): Promise<void> {
    const messageId = payload.messages[0]?.key?.id ?? 'without-id';
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.onMessageReceive!(payload, settings);
        return;
      } catch (error) {
        if (attempt >= this.maxRetries) {
          this.processorLogs.error(
            `Message ${messageId} exhausted ${this.maxRetries} retries without blocking the batch: ${error}`,
          );
          return;
        }
        this.processorLogs.warn(
          `Retrying message ${messageId} after attempt ${attempt + 1}: ${(error as Error).message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  onDestroy() {
    this.destroyed = true;
    this.onMessageReceive = undefined;
  }
}
