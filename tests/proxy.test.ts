import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Agent } from 'undici';
import { bbxFetch, httpsProxyUrl, proxyFetch } from '../src/proxy.js';

/** A proxy that records each CONNECT target and refuses it, so no request leaves the machine. */
async function recordingProxy(): Promise<{ url: string; targets: string[]; close: () => Promise<void> }> {
  const targets: string[] = [];
  const server = createServer();
  server.on('connect', (request, socket) => {
    targets.push(request.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    targets,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

test('without a proxy in the environment the default fetch is kept', () => {
  assert.equal(httpsProxyUrl({}), undefined);
  assert.equal(httpsProxyUrl({ HTTPS_PROXY: '  ' }), undefined);
  assert.equal(proxyFetch({}, {}), undefined);
  assert.equal(bbxFetch({}), globalThis.fetch);
});

test('the proxy is read from either spelling of the variable', () => {
  assert.equal(httpsProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:1' }), 'http://127.0.0.1:1');
  assert.equal(httpsProxyUrl({ https_proxy: 'http://127.0.0.1:2' }), 'http://127.0.0.1:2');
});

test('requests go through the proxy, even when the caller sends its own dispatcher', async () => {
  const proxy = await recordingProxy();
  try {
    const viaProxy = proxyFetch({ bodyTimeout: 0 }, { HTTPS_PROXY: proxy.url });
    assert.ok(viaProxy);
    await assert.rejects(viaProxy('https://api.example.invalid/v1/key'));
    // @vercel/sandbox passes a direct-connecting dispatcher with every request.
    const withOwnDispatcher = { dispatcher: new Agent() } as unknown as RequestInit;
    await assert.rejects(viaProxy('https://sandbox.example.invalid/v2/sandboxes', withOwnDispatcher));
    assert.deepEqual(proxy.targets, ['api.example.invalid:443', 'sandbox.example.invalid:443']);
  } finally {
    await proxy.close();
  }
});

test('hosts listed in NO_PROXY bypass the proxy', async () => {
  const proxy = await recordingProxy();
  try {
    const viaProxy = proxyFetch({}, { HTTPS_PROXY: proxy.url, NO_PROXY: 'direct.example.invalid' });
    assert.ok(viaProxy);
    await assert.rejects(viaProxy('https://direct.example.invalid/'));
    assert.deepEqual(proxy.targets, []);
  } finally {
    await proxy.close();
  }
});
