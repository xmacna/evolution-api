import { RouterBroker } from '@api/abstract/abstract.router';
import { metaController } from '@api/server.module';
import { ConfigService, WaBusiness } from '@config/env.config';
import { Router } from 'express';

import { hasCoexistenceChanges, MetaRawRequest, verifyMetaSignature } from './meta-webhook-security';

export class MetaRouter extends RouterBroker {
  constructor(readonly configService: ConfigService) {
    super();
    this.router
      .get(this.routerPath('webhook/meta', false), async (req, res) => {
        if (req.query['hub.verify_token'] === configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK)
          res.send(req.query['hub.challenge']);
        else res.send('Error, wrong validation token');
      })
      .post(this.routerPath('webhook/meta', false), async (req, res) => {
        const { body } = req;
        const config = configService.get<WaBusiness>('WA_BUSINESS');
        const requiresSignature =
          hasCoexistenceChanges(body) || !!config.APP_SECRET || config.ALLOW_UNSIGNED_LEGACY === false;
        if (requiresSignature) {
          if (!config.APP_SECRET) {
            return res.status(503).json({ error: 'Meta webhook signature verification unavailable' });
          }
          if (
            !verifyMetaSignature(
              (req as typeof req & MetaRawRequest).metaRawBody,
              req.headers['x-hub-signature-256'],
              config.APP_SECRET,
            )
          ) {
            return res.status(403).json({ error: 'Meta webhook signature verification failed' });
          }
        }
        const response = await metaController.receiveWebhook(body);

        return res.status(200).json(response);
      });
  }

  public readonly router: Router = Router();
}
