import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

type Env = Record<string, string | undefined>;

function setting(env: Env, name: string): string | undefined {
  return (env[name] ?? env[name.toLowerCase()])?.trim() || undefined;
}

/** The proxy the environment names for HTTPS requests, if any. */
export function httpsProxyUrl(env: Env = process.env): string | undefined {
  return setting(env, 'HTTPS_PROXY');
}

/**
 * A `fetch` that sends requests through the proxy named by `HTTPS_PROXY`
 * (honouring `NO_PROXY`), or undefined when no proxy is set and the default
 * `fetch` should be used.
 *
 * Node's own `fetch` ignores these variables unless `NODE_USE_ENV_PROXY=1` is
 * set, and `@vercel/sandbox` sends every request with its own dispatcher, which
 * connects directly even then. Where all outbound traffic must go through a
 * proxy, such as a cloud development container, both fail with "fetch failed".
 *
 * `bodyTimeout` is undici's limit on the gap between two chunks of a response,
 * in milliseconds. Pass 0 to switch it off.
 */
export function proxyFetch(
  options: { bodyTimeout?: number } = {},
  env: Env = process.env,
): typeof globalThis.fetch | undefined {
  const httpsProxy = httpsProxyUrl(env);
  if (!httpsProxy) return undefined;
  const noProxy = setting(env, 'NO_PROXY');
  const dispatcher = new EnvHttpProxyAgent({
    httpsProxy,
    ...(noProxy === undefined ? {} : { noProxy }),
    ...(options.bodyTimeout === undefined ? {} : { bodyTimeout: options.bodyTimeout }),
  });
  // A caller's own `dispatcher` (the sandbox SDK always sends one) is replaced on purpose.
  const viaProxy = (input: unknown, init?: object) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher });
  return viaProxy as unknown as typeof globalThis.fetch;
}

/** The `fetch` bbx uses for its own OpenRouter requests. */
export function bbxFetch(env: Env = process.env): typeof globalThis.fetch {
  return proxyFetch({}, env) ?? globalThis.fetch;
}
