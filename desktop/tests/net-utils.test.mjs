import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  calculateTransferBps,
  evaluateAggregateDelay,
  fetchPublicIp,
  fetchPublicIpThroughHttpProxy,
  getFreePort,
  isUsablePublicIp,
  parsePublicCountryBody,
  parsePublicIpBody,
  probeMultipleTargets,
  probeTargetEvidence,
  requestThroughHttpProxy,
  isDelayResponseStatus,
  sanitizeLog,
  selectMedianDelaySample,
  selectPreferredDelaySample,
  selectSlowestDelaySample,
  tcpPing,
  uploadThroughHttpProxy,
  waitForPort,
} from '../net-utils.mjs';

test('TCP ping and port readiness use a real socket', async t => {
  const port = await getFreePort();
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', error => error ? reject(error) : resolve()));
  t.after(() => server.close());
  assert.equal(await waitForPort(port, 1000), true);
  const result = await tcpPing('127.0.0.1', port, 1000);
  assert.equal(result.ok, true);
  assert.ok(result.latency >= 0);
});

test('TCP ping returns an explicit failure for a closed port', async () => {
  const port = await getFreePort();
  const result = await tcpPing('127.0.0.1', port, 200);
  assert.deepEqual(result, { latency: -1, ok: false });
});

test('real-delay selection uses the median valid sample', () => {
  const selected = selectMedianDelaySample([
    { ok: false, elapsed: 3 },
    { ok: true, elapsed: 420 },
    { ok: true, elapsed: 85 },
    { ok: true, elapsed: 160 },
    { ok: true, elapsed: Number.NaN },
  ]);
  assert.deepEqual(selected, { ok: true, elapsed: 160 });
  assert.equal(selectMedianDelaySample([{ ok: false, elapsed: 20 }]), null);
});

test('multi-target real delay uses the slowest valid service response', () => {
  const samples = [
    { ok: true, elapsed: 85, target: 'general' },
    { ok: false, elapsed: 900, target: 'failed' },
    { ok: true, elapsed: 420, target: 'meta' },
  ];
  const selected = selectSlowestDelaySample(samples);
  assert.deepEqual(selected, { ok: true, elapsed: 420, target: 'meta' });
  assert.deepEqual(
    selectPreferredDelaySample(samples, 'general'),
    { ok: true, elapsed: 85, target: 'general' },
  );
  assert.equal(selectPreferredDelaySample(samples, 'failed'), null);
  assert.equal(isDelayResponseStatus(204), true);
  assert.equal(isDelayResponseStatus(404), true);
  assert.equal(isDelayResponseStatus(500), false);
});

test('bandwidth calculation reports bits per second from payload bytes', () => {
  assert.equal(calculateTransferBps(512 * 1024, 1000), 4_194_304);
  assert.equal(calculateTransferBps(0, 1000), -1);
  assert.equal(calculateTransferBps(1000, 0), 8_000_000);
});

test('public IP parser accepts JSON, trace, and plain-text responses', () => {
  assert.equal(parsePublicIpBody('{"ip":"203.0.113.7"}'), '203.0.113.7');
  assert.equal(parsePublicIpBody('warp=off\nip=2001:db8::7\nts=1'), '2001:db8::7');
  assert.equal(parsePublicIpBody('203.0.113.8\n'), '203.0.113.8');
  assert.equal(parsePublicIpBody('not-an-ip'), '');
  assert.equal(isUsablePublicIp('203.0.113.8'), true);
  assert.equal(isUsablePublicIp('127.0.0.1'), false);
  assert.equal(isUsablePublicIp('10.0.0.1'), false);
  assert.equal(isUsablePublicIp('fd00::1'), false);
});

test('public IP fallback gets a fresh timeout signal after an endpoint stalls', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, abortedAtStart: options.signal.aborted });
    if (url === 'slow') {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return {
      ok: true,
      status: 200,
      text: async () => 'ip=203.0.113.9\n',
    };
  };

  const result = await fetchPublicIp(600, {
    endpoints: ['slow', 'fast'],
    fetch: fakeFetch,
  });

  assert.deepEqual(result, { ok: true, ip: '203.0.113.9' });
  assert.deepEqual(calls, [
    { url: 'slow', abortedAtStart: false },
    { url: 'fast', abortedAtStart: false },
  ]);
});

test('HTTP proxy transfer measures download and upload after CONNECT', async t => {
  const downloadBytes = 128 * 1024;
  const uploadBytes = 64 * 1024;
  const origin = http.createServer((request, response) => {
    if (request.url === '/ip') {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': '16',
      });
      response.end('ip=203.0.113.10\n');
      return;
    }
    if (request.url === '/ip-with-country') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('ip=203.0.113.10\nloc=DE\n');
      return;
    }
    if (request.url === '/private-ip') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('ip=127.0.0.1\n');
      return;
    }
    if (request.url === '/download') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(downloadBytes),
      });
      response.end(Buffer.alloc(downloadBytes, 65));
      return;
    }
    if (request.url === '/upload' && request.method === 'POST') {
      let received = 0;
      request.on('data', chunk => { received += chunk.length; });
      request.on('end', () => {
        response.writeHead(received === uploadBytes ? 204 : 400);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    origin.listen(0, '127.0.0.1', error => error ? reject(error) : resolve());
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));
  const originPort = origin.address().port;

  const proxy = net.createServer(client => {
    let pending = Buffer.alloc(0);
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      const headerEnd = pending.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      client.off('data', onData);
      const firstLine = pending.subarray(0, headerEnd).toString('latin1').split('\r\n')[0];
      const target = firstLine.match(/^CONNECT\s+([^:]+):(\d+)\s+/i);
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = net.connect({
        host: target[1],
        port: Number(target[2]),
      }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const remainder = pending.subarray(headerEnd + 4);
        if (remainder.length > 0) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await new Promise((resolve, reject) => {
    proxy.listen(0, '127.0.0.1', error => error ? reject(error) : resolve());
  });
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const proxyPort = proxy.address().port;

  const exitIp = await fetchPublicIpThroughHttpProxy(proxyPort, 2000, {
    endpoints: [`http://127.0.0.1:${originPort}/ip`],
  });
  assert.deepEqual(exitIp, { ok: true, ip: '203.0.113.10' });
  const exitIpWithCountry = await fetchPublicIpThroughHttpProxy(proxyPort, 2000, {
    endpoints: [`http://127.0.0.1:${originPort}/ip-with-country`],
  });
  assert.deepEqual(exitIpWithCountry, { ok: true, ip: '203.0.113.10', country: 'DE' });
  const privateExitIp = await fetchPublicIpThroughHttpProxy(proxyPort, 2000, {
    endpoints: [`http://127.0.0.1:${originPort}/private-ip`],
  });
  assert.equal(privateExitIp.ok, false);
  assert.equal(privateExitIp.ip, '');
  assert.equal(privateExitIp.country, undefined);

  const download = await requestThroughHttpProxy(
    proxyPort,
    `http://127.0.0.1:${originPort}/download`,
    { timeoutMs: 2000, maxBytes: downloadBytes }
  );
  assert.equal(download.ok, true);
  assert.equal(download.bytes, downloadBytes);
  assert.ok(download.bps > 0);

  const upload = await uploadThroughHttpProxy(
    proxyPort,
    `http://127.0.0.1:${originPort}/upload`,
    { timeoutMs: 2000, bytes: uploadBytes }
  );
  assert.equal(upload.ok, true);
  assert.equal(upload.bytes, uploadBytes);
  assert.ok(upload.bps > 0);
  assert.ok(upload.writeElapsed > 0);
  assert.ok(upload.responseElapsed >= upload.writeElapsed);
  assert.equal(upload.responseBeforeRequestFinished, false);
});

test('public country parser extracts 2-letter ISO country codes from trace and JSON', () => {
  assert.equal(parsePublicCountryBody('loc=DE\nip=1.2.3.4'), 'DE');
  assert.equal(parsePublicCountryBody('country=US\n'), 'US');
  assert.equal(parsePublicCountryBody('{"ip":"1.2.3.4","country_code":"FR"}'), 'FR');
  assert.equal(parsePublicCountryBody('{"ip":"1.2.3.4","countryCode":"GB"}'), 'GB');
  assert.equal(parsePublicCountryBody('{"ip":"1.2.3.4","country":"NL"}'), 'NL');
  assert.equal(parsePublicCountryBody('{"ip":"1.2.3.4","loc":"37.3860,-122.0838"}'), '');
  assert.equal(parsePublicCountryBody('1.2.3.4'), '');
  assert.equal(parsePublicCountryBody(''), '');
  assert.equal(parsePublicCountryBody(null), '');
});

test('public IP resolution propagates measured country only when public IP is usable', async () => {
  const fakeFetchUsable = async () => ({
    ok: true,
    status: 200,
    text: async () => 'ip=203.0.113.50\nloc=DE\n',
  });
  const resUsable = await fetchPublicIp(1000, {
    endpoints: ['trace'],
    fetch: fakeFetchUsable,
  });
  assert.deepEqual(resUsable, { ok: true, ip: '203.0.113.50', country: 'DE' });

  const fakeFetchPrivate = async () => ({
    ok: true,
    status: 200,
    text: async () => 'ip=10.0.0.1\nloc=US\n',
  });
  const resPrivate = await fetchPublicIp(1000, {
    endpoints: ['trace'],
    fetch: fakeFetchPrivate,
  });
  assert.equal(resPrivate.ok, false);
  assert.equal(resPrivate.ip, '');
  assert.equal(resPrivate.country, undefined);
});

test('sanitizeLog strips raw URIs, credentials, UUIDs and IPs', () => {
  const rawLog = 'Connecting vless://uuid-1234@192.168.1.1:443?type=tcp and hysteria2://secret@10.0.0.1:8443#Name with 12345678-1234-1234-1234-123456789abc';
  const sanitized = sanitizeLog(rawLog);
  assert.ok(!sanitized.includes('vless://'));
  assert.ok(!sanitized.includes('hysteria2://'));
  assert.ok(!sanitized.includes('192.168.1.1'));
  assert.ok(!sanitized.includes('12345678-1234-1234-1234-123456789abc'));
  assert.ok(sanitized.includes('[config]'));
  assert.ok(sanitized.includes('[id]'));
});

test('evaluateAggregateDelay enforces strict aggregate required-target success', () => {
  const target1 = {
    target: 'https://www.youtube.com/generate_204',
    destination: 'www.youtube.com',
    ok: true,
    status: 204,
    statusCode: 204,
    latencyMs: 120,
    elapsed: 120,
    bytes: 0,
    body: '',
    error: null,
    checkedAt: Date.now(),
    tier: 'tier1',
    browserVerified: true,
  };
  const target2 = {
    target: 'https://www.google.com/generate_204',
    destination: 'www.google.com',
    ok: true,
    status: 204,
    statusCode: 204,
    latencyMs: 150,
    elapsed: 150,
    bytes: 0,
    body: '',
    error: null,
    checkedAt: Date.now(),
    tier: 'tier1',
    browserVerified: true,
  };
  const target3Fail = {
    target: 'https://www.facebook.com/generate_204',
    destination: 'www.facebook.com',
    ok: false,
    status: 0,
    statusCode: 0,
    latencyMs: -1,
    elapsed: -1,
    bytes: 0,
    body: '',
    error: 'Probe deadline exceeded',
    checkedAt: Date.now(),
    tier: 'tier1',
    browserVerified: false,
  };

  // Case 1: All pass -> strict aggregate passes
  const allPass = evaluateAggregateDelay([target1, target2]);
  assert.equal(allPass.ok, true);
  assert.equal(allPass.allPassed, true);
  assert.equal(allPass.requiredPassed, true);
  assert.equal(allPass.latency, 150); // median
  assert.equal(allPass.worstLatency, 150);
  assert.equal(allPass.bestLatency, 120);
  assert.equal(allPass.jitter, 30);

  // Case 2: One target fails -> strict aggregate fails (default strict mode)
  const oneFails = evaluateAggregateDelay([target1, target2, target3Fail]);
  assert.equal(oneFails.ok, false);
  assert.equal(oneFails.allPassed, false);
  assert.equal(oneFails.requiredPassed, false);
  assert.equal(oneFails.passedCount, 2);
  assert.equal(oneFails.totalCount, 3);
  assert.equal(oneFails.latency, 150); // Valid samples are still aggregated

  // Case 3: Lenient aggregate (strictAggregate: false) -> passes if at least one passes
  const lenient = evaluateAggregateDelay([target1, target3Fail], { strictAggregate: false });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.passedCount, 1);

  // Case 4: Explicit required targets
  const explicit = evaluateAggregateDelay([target1, target3Fail], {
    requiredTestUrls: ['https://www.youtube.com/generate_204'],
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.requiredPassed, true);

  // Case 5: Explicit required target failed
  const explicitFailed = evaluateAggregateDelay([target1, target3Fail], {
    requiredTestUrls: ['https://www.facebook.com/generate_204'],
  });
  assert.equal(explicitFailed.ok, false);
  assert.equal(explicitFailed.requiredPassed, false);

  // Case 6: Exceeds maxLatencyMs
  const latencyExceeded = evaluateAggregateDelay([target1, target2], { maxLatencyMs: 130 });
  assert.equal(latencyExceeded.ok, false); // worst is 150 > 130
});

test('probeTargetEvidence handles protocol validation, destination and failure records', async () => {
  const resultNonHttps = await probeTargetEvidence(12345, 'http://example.com/generate_204');
  assert.equal(resultNonHttps.ok, false);
  assert.equal(resultNonHttps.status, 0);
  assert.equal(resultNonHttps.statusCode, 0);
  assert.equal(resultNonHttps.latencyMs, -1);
  assert.equal(resultNonHttps.elapsed, -1);
  assert.equal(resultNonHttps.latency, -1);
  assert.equal(resultNonHttps.bytes, 0);
  assert.equal(resultNonHttps.body, '');
  assert.equal(resultNonHttps.target, 'http://example.com/generate_204');
  assert.equal(resultNonHttps.url, 'http://example.com/generate_204');
  assert.equal(resultNonHttps.destination, 'example.com');
  assert.equal(resultNonHttps.tier, 'general');
  assert.equal(resultNonHttps.browserVerified, false);
  assert.ok(resultNonHttps.error?.includes('Only HTTPS'));
  assert.ok(resultNonHttps.checkedAt > 0);

  const resultClosedPort = await probeTargetEvidence(9, 'https://www.youtube.com/generate_204', { timeoutMs: 300 });
  assert.equal(resultClosedPort.ok, false);
  assert.equal(resultClosedPort.status, 0);
  assert.equal(resultClosedPort.statusCode, 0);
  assert.equal(resultClosedPort.latencyMs, -1);
  assert.equal(resultClosedPort.target, 'https://www.youtube.com/generate_204');
  assert.equal(resultClosedPort.destination, 'www.youtube.com');
  assert.equal(resultClosedPort.tier, 'tier1');
  assert.equal(resultClosedPort.browserVerified, false);
  assert.ok(resultClosedPort.error);

  const emptyResults = await probeMultipleTargets(9, []);
  assert.deepEqual(emptyResults, []);
});
