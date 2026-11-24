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
    const changes = (data.entry || []).flatMap((entry: any) =>
      (entry.changes || []).map((change: any) => ({ entry, change })),
    );
    const strictFields = ['smb_message_echoes', 'history', 'smb_app_state_sync'];
    const ordered = [
      ...changes.filter(({ change }) => strictFields.includes(change?.field)),
      ...changes.filter(({ change }) => !strictFields.includes(change?.field)),
    ];
    // A strict failure retries the entire Meta batch. Do not launch ordinary
    // best-effort work until every strict change has been safely accepted.
    for (const { entry, change } of ordered) {
      if (change?.field === 'message_template_status_update') {
        const template = await this.prismaRepository.template.findFirst({
          where: { templateId: `${change.value.message_template_id}` },
        });
        if (template) {
          await axios.post(template.webhookUrl, change.value, {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        continue;
      }
      const numberId = change?.value?.metadata?.phone_number_id;
      if (!numberId) {
        if (strictFields.includes(change?.field)) {
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
    return { status: 'success' };
  }
}
