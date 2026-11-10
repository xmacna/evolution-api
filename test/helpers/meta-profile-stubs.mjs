// Limited stubs for the import block of whatsapp.business.service.ts only (test/xmacna-meta-profile-optional.test.mjs). No network: axios counts calls in globalThis.__AXIOS_CALLS.
class ChannelStartupService {
  constructor(configService, eventEmitter, prismaRepository, chatwootCache) {
    this.configService = configService; this.eventEmitter = eventEmitter; this.prismaRepository = prismaRepository; this.chatwootCache = chatwootCache;
    this.chatwootService = { eventWhatsapp: async () => null };
  }
  loadChatwoot() {}
  async findSettings() { return {}; }
}
const Events = new Proxy({}, { get: (_, k) => String(k) });
const fn = (name) => new Proxy(function () {}, {
  get: (_, k) => (k === 'then' ? undefined : fn(name + '.' + String(k))),
  apply: () => undefined, construct: () => ({}),
});
const axios = new Proxy({}, { get: () => async () => { globalThis.__AXIOS_CALLS = (globalThis.__AXIOS_CALLS || 0) + 1; return { data: {} }; } });
const MAP = {
  ChannelStartupService, Events, axios,
  chatbotController: { emit: async () => {} },
  status: { 0: 'ERROR', 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ', 5: 'PLAYED' },
  createJid: (n) => (n == null ? n : String(n).includes('@') ? String(n) : String(n) + '@s.whatsapp.net'),
  sendTelemetry: () => {},
};
export function __stub(name) { return name in MAP ? MAP[name] : fn(name); }
