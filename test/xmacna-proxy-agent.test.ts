import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { makeProxyAgent, makeProxyAgentUndici } from '../src/utils/makeProxyAgent';

test('HTTP and HTTPS proxy URLs construct the socket agent without opening a connection', () => {
  for (const protocol of ['http', 'https']) {
    const agent = makeProxyAgent(`${protocol}://proxy.example.invalid:8443`);
    assert.ok(agent instanceof HttpsProxyAgent);
    assert.equal(agent.proxy.protocol, `${protocol}:`);
    assert.equal(agent.proxy.hostname, 'proxy.example.invalid');
    agent.destroy();
  }
});

test('SOCKS4 stays version four while the existing SOCKS aliases stay version five', () => {
  for (const [protocol, version] of [['socks4', 4], ['socks5', 5], ['socks', 5]] as const) {
    const agent = makeProxyAgent(`${protocol}://proxy.example.invalid:1080`);
    assert.ok(agent instanceof SocksProxyAgent);
    assert.equal(agent.proxy.type, version);
    assert.equal(agent.proxy.host, 'proxy.example.invalid');
    assert.equal(agent.proxy.port, 1080);
    agent.destroy();
  }
});

test('socket agent accepts the protocols also accepted by the Undici object factory', () => {
  for (const protocol of ['http', 'https', 'socks4', 'socks5', 'socks']) {
    const agent = makeProxyAgent({ protocol, host: 'proxy.example.invalid', port: '8443' });
    assert.ok(agent instanceof HttpsProxyAgent || agent instanceof SocksProxyAgent);
    agent.destroy();
  }
});

test('Undici accepts the socks URL alias just as it accepts its object form', async () => {
  for (const value of [
    'socks://proxy.example.invalid:1080',
    { protocol: 'socks', host: 'proxy.example.invalid', port: '1080' },
  ]) {
    const agent = makeProxyAgentUndici(value);
    await agent.close();
  }
});

test('existing encoded SOCKS URL credentials survive protocol selection', () => {
  const agent = makeProxyAgent('socks5://fixture%40user:fixture%3Apassword@proxy.example.invalid:1080');
  assert.ok(agent instanceof SocksProxyAgent);
  assert.equal(agent.proxy.userId, 'fixture@user');
  assert.equal(agent.proxy.password, 'fixture:password');
  agent.destroy();
});

test('unsupported protocols remain explicit errors in both factories', () => {
  for (const make of [makeProxyAgent, makeProxyAgentUndici]) {
    assert.throws(() => make('ftp://proxy.example.invalid:21'), /Unsupported proxy protocol/);
  }
});
