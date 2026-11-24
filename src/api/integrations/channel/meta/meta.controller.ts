import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data?.object !== 'whatsapp_business_account') return { status: 'success' };
    for (const entry of data.entry || []) {
      for (const change of entry.changes || []) {
        if (change?.field === 'message_template_status_update') {
          const template = await this.prismaRepository.template.findFirst({
            where: { templateId: `${change.value.message_template_id}` },
          });
          if (template) await axios.post(template.webhookUrl, change.value, {
            headers: { 'Content-Type': 'application/json' },
          });
          continue;
        }
        const numberId = change?.value?.metadata?.phone_number_id;
        if (!numberId) {
          if (change?.field === 'smb_message_echoes' && change.value?.message_echoes?.length) {
            throw new Error('Business app echo phone binding missing');
          }
          continue;
        }
        const instance = await this.prismaRepository.instance.findFirst({ where: { number: numberId } });
        const client = instance && this.waMonitor.waInstances[instance.name];
        if (!client) throw new Error('Meta webhook bound instance unavailable');
        // Do not pass another tenant's entries/changes to this instance.
        await client.connectToWhatsapp({ ...data, entry: [{ ...entry, changes: [change] }] });
      }
    }
    return { status: 'success' };
  }
}
