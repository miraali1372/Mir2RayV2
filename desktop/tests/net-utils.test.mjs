import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  calculateTransferBps,
  fetchPublicIp,
  fetchPublicIpThroughHttpProxy,
  getFreePort,
  isUsablePublicIp,
  parsePublicIpBody,
  requestThroughHttpProxy,
  isDelayResponseStatus,
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
  const privateExitIp = await fetchPublicIpThroughHttpProxy(proxyPort, 2000, {
    endpoints: [`http://127.0.0.1:${originPort}/private-ip`],
  });
  assert.equal(privateExitIp.ok, false);
  assert.equal(privateExitIp.ip, '');

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
