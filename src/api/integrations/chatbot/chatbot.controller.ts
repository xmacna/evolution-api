import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import {
  difyController,
  evoaiController,
  evolutionBotController,
  flowiseController,
  n8nController,
  openaiController,
  typebotController,
} from '@api/server.module';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import { IntegrationSession } from '@prisma/client';
import { findBotByTrigger } from '@utils/findBotByTrigger';

import { ChatbotDebounceStore, processChatbotDebounce } from './chatbotDebounce';
import { runBestEffortChatbots } from './chatbotDispatchPolicy';

export type EmitData = {
  instance: InstanceDto;
  remoteJid: string;
  msg: any;
  pushName?: string;
};

export interface ChatbotControllerInterface {
  integrationEnabled: boolean;
  botRepository: any;
  settingsRepository: any;
  sessionRepository: any;
  userMessageDebounce: ChatbotDebounceStore;

  createBot(instance: InstanceDto, data: any): Promise<any>;
  findBot(instance: InstanceDto): Promise<any>;
  fetchBot(instance: InstanceDto, botId: string): Promise<any>;
  updateBot(instance: InstanceDto, botId: string, data: any): Promise<any>;
  deleteBot(instance: InstanceDto, botId: string): Promise<any>;

  settings(instance: InstanceDto, data: any): Promise<any>;
  fetchSettings(instance: InstanceDto): Promise<any>;

  changeStatus(instance: InstanceDto, botId: string, status: string): Promise<any>;
  fetchSessions(instance: InstanceDto, botId: string, remoteJid?: string): Promise<any>;
  ignoreJid(instance: InstanceDto, data: any): Promise<any>;

  emit(data: EmitData): Promise<void>;
}

export class ChatbotController {
  public prismaRepository: PrismaRepository;
  public waMonitor: WAMonitoringService;

  public readonly logger = new Logger('ChatbotController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    this.prisma = prismaRepository;
    this.monitor = waMonitor;
  }

  public set prisma(prisma: PrismaRepository) {
    this.prismaRepository = prisma;
  }

  public get prisma() {
    return this.prismaRepository;
  }

  public set monitor(waMonitor: WAMonitoringService) {
    this.waMonitor = waMonitor;
  }

  public get monitor() {
    return this.waMonitor;
  }

  public async emit({
    instance,
    remoteJid,
    msg,
    pushName,
    isIntegration = false,
  }: {
    instance: InstanceDto;
    remoteJid: string;
    msg: any;
    pushName?: string;
    isIntegration?: boolean;
  }): Promise<void> {
    const emitData = {
      instance,
      remoteJid,
      msg,
      pushName,
      isIntegration,
    };
    await this.emitDurableInbound(emitData);
    await this.emitBestEffortInbound(emitData);
  }

  /**
   * The legacy receipt column is named `chatbotState`, but its durable
   * contract is specifically the n8n delivery. Running n8n alone lets the
   * caller persist `sent` before any non-durable integrator can have effects.
   */
  public async emitDurableInbound(data: EmitData): Promise<void> {
    await n8nController.emit(data);
  }

  /**
   * Other chatbot integrations remain best-effort. They run only after n8n is
   * durably acknowledged and are never allowed to reopen the n8n receipt.
   */
  public async emitBestEffortInbound(data: EmitData): Promise<void> {
    await runBestEffortChatbots(
      [
        { name: 'evolutionBot', emit: () => evolutionBotController.emit(data) },
        { name: 'typebot', emit: () => typebotController.emit(data) },
        { name: 'openai', emit: () => openaiController.emit(data) },
        { name: 'dify', emit: () => difyController.emit(data) },
        { name: 'evoai', emit: () => evoaiController.emit(data) },
        { name: 'flowise', emit: () => flowiseController.emit(data) },
      ],
      (name, error) =>
        this.logger.error(`Best-effort chatbot ${name} failed after durable n8n delivery: ${error.message}`),
    );
  }

  public processDebounce(
    userMessageDebounce: ChatbotDebounceStore,
    content: string,
    debounceKey: string,
    debounceTime: number,
    callback: any,
  ): Promise<void> {
    return processChatbotDebounce(
      userMessageDebounce,
      content,
      debounceKey,
      debounceTime,
      callback,
      (merged) => this.logger.log('message debounced: ' + merged),
      (flushed) => this.logger.log('Debounce complete. Processing message: ' + flushed),
    );
  }

  public checkIgnoreJids(ignoreJids: any, remoteJid: string) {
    if (ignoreJids && ignoreJids.length > 0) {
      let ignoreGroups = false;
      let ignoreContacts = false;

      if (ignoreJids.includes('@g.us')) {
        ignoreGroups = true;
      }

      if (ignoreJids.includes('@s.whatsapp.net')) {
        ignoreContacts = true;
      }

      if (ignoreGroups && remoteJid.endsWith('@g.us')) {
        this.logger.warn('Ignoring message from group: ' + remoteJid);
        return true;
      }

      if (ignoreContacts && remoteJid.endsWith('@s.whatsapp.net')) {
        this.logger.warn('Ignoring message from contact: ' + remoteJid);
        return true;
      }

      if (ignoreJids.includes(remoteJid)) {
        this.logger.warn('Ignoring message from jid: ' + remoteJid);
        return true;
      }

      return false;
    }

    return false;
  }

  public async getSession(remoteJid: string, instance: InstanceDto) {
    let session = await this.prismaRepository.integrationSession.findFirst({
      where: {
        remoteJid: remoteJid,
        instanceId: instance.instanceId,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (session) {
      if (session.status !== 'closed' && !session.botId) {
        this.logger.warn('Session is already opened in another integration');
        return null;
      } else if (!session.botId) {
        session = null;
      }
    }

    return session;
  }

  public async findBotTrigger(
    botRepository: any,
    content: string,
    instance: InstanceDto,
    session?: IntegrationSession,
  ) {
    let findBot: any = null;

    if (!session) {
      findBot = await findBotByTrigger(botRepository, content, instance.instanceId);

      if (!findBot) {
        return null;
      }
    } else {
      findBot = await botRepository.findFirst({
        where: {
          id: session.botId,
        },
      });
    }

    return findBot;
  }
}
