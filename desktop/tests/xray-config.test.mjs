import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMainConfig, buildProxyOutbound, buildSpeedTestConfig, parseShareUri } from '../xray-config.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';
const VLESS = `vless://${UUID}@example.com:443?encryption=none&security=reality&sni=cdn.example.com&fp=chrome&pbk=test-public-key&sid=abcd&type=ws&host=cdn.example.com&path=%2Fws#Example`;

test('parses and builds VLESS Reality over WebSocket', () => {
  const profile = parseShareUri(VLESS);
  assert.equal(profile.configType, 'vless');
  assert.equal(profile.network, 'ws');
  assert.equal(profile.security, 'reality');
  const outbound = buildProxyOutbound(VLESS);
  assert.equal(outbound.protocol, 'vless');
  assert.equal(outbound.streamSettings.wsSettings.path, '/ws');
  assert.equal(outbound.streamSettings.realitySettings.serverName, 'cdn.example.com');
});

test('parses VMess JSON and Shadowsocks SIP002 links', () => {
  const vmessBody = Buffer.from(JSON.stringify({
    v: '2', ps: 'VMess Test', add: 'example.net', port: '8443', id: UUID,
    aid: '0', scy: 'auto', net: 'grpc', type: 'multi', host: 'grpc.example.net',
    path: 'service', tls: 'tls', sni: 'grpc.example.net', fp: 'chrome',
  })).toString('base64');
  const vmess = buildProxyOutbound(`vmess://${vmessBody}`);
  assert.equal(vmess.protocol, 'vmess');
  assert.equal(vmess.streamSettings.grpcSettings.serviceName, 'service');

  const userInfo = Buffer.from('aes-256-gcm:test-password').toString('base64url');
  const shadowsocks = buildProxyOutbound(`ss://${userInfo}@example.org:8388#SS-Test`);
  assert.equal(shadowsocks.protocol, 'shadowsocks');
  assert.equal(shadowsocks.settings.servers[0].method, 'aes-256-gcm');
});

test('builds isolated speed-test configuration', () => {
  const config = buildSpeedTestConfig({ shareUri: VLESS }, 19080);
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].protocol, 'http');
  assert.equal(config.inbounds[0].port, 19080);
  assert.equal(config.routing.rules[0].outboundTag, 'proxy');
  assert.equal(config.inbounds.some(item => item.protocol === 'tun'), false);
});

test('builds Windows full-tunnel configuration with automatic routes and stats API', () => {
  const config = buildMainConfig({ shareUri: VLESS, dnsIp: '1.1.1.1' }, {
    socksPort: 19081, httpPort: 19082, apiPort: 19083,
  });
  const tun = config.inbounds.find(item => item.protocol === 'tun');
  assert.ok(tun);
  assert.deepEqual(tun.settings.autoSystemRoutingTable, ['0.0.0.0/0', '::/0']);
  assert.equal(tun.settings.autoOutboundsInterface, 'auto');
  assert.equal(config.api.services[0], 'StatsService');
  assert.ok(config.routing.rules.some(rule => rule.inboundTag?.includes('api') && rule.outboundTag === 'api'));
  const quicBlockIndex = config.routing.rules.findIndex(rule =>
    rule.port === 443 && rule.network === 'udp' && rule.outboundTag === 'block'
  );
  const proxyIndex = config.routing.rules.findIndex(rule =>
    rule.inboundTag?.includes('tun') && rule.network === 'tcp,udp' && rule.outboundTag === 'proxy'
  );
  assert.ok(quicBlockIndex >= 0);
  assert.ok(proxyIndex > quicBlockIndex);
});

test('clean IP changes only the dial address and preserves TLS identity', () => {
  const outbound = buildProxyOutbound(VLESS, { cleanIp: '203.0.113.10' });
  assert.equal(outbound.settings.vnext[0].address, '203.0.113.10');
  assert.equal(outbound.streamSettings.realitySettings.serverName, 'cdn.example.com');
  assert.equal(outbound.streamSettings.wsSettings.host, 'cdn.example.com');
});
