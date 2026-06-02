import dns from 'dns';
import net from 'net';
import type { LookupFunction } from 'net';

import ipaddr from 'ipaddr.js';
import { Agent, fetch, type Dispatcher, type Response } from 'undici';

import { config } from '../config';

// Thrown when a user-supplied URL resolves to an address we refuse to reach.
// Routes catch this to return a 400 instead of letting it bubble as a 500.
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

// Only ordinary public unicast traffic is allowed. Every other ipaddr.js
// range (loopback, private, linkLocal, uniqueLocal, multicast, reserved…)
// can reach something internal and is blocked.
const isBlockedAddress = (ip: string): boolean => {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1) reports range "ipv4Mapped",
  // hiding the real classification — unwrap and re-check the IPv4 inside.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isBlockedAddress(v6.toIPv4Address().toString());
    }
  }
  return addr.range() !== 'unicast';
};

export const assertUrlAllowed = async (rawUrl: string): Promise<void> => {
  if (config.booru.allowPrivateHosts) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Only http:// and https:// URLs are allowed');
  }

  // URL keeps the brackets on IPv6 literals; net.isIP and ipaddr want them bare.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      const resolved = await dns.promises.lookup(host, { all: true });
      addresses = resolved.map((entry) => entry.address);
    } catch {
      throw new SsrfBlockedError(`Could not resolve host "${host}"`);
    }
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`Could not resolve host "${host}"`);
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(
        `Refusing to connect to a private or internal address (${address}). ` +
          'Set ALLOW_PRIVATE_BOORU_HOSTS=true to allow a self-hosted booru on your local network.'
      );
    }
  }
};

const MAX_REDIRECTS = 5;

// Connection-time DNS guard. Resolving here and handing undici the validated
// address means the IP we checked is the exact IP we connect to — closing the
// rebinding window between a separate pre-check lookup and the real connect.
// (Multiple A records are all validated; the first is used.)
const validatingLookup: LookupFunction = (hostname, options, callback) => {
  const done = (typeof options === 'function' ? options : callback) as (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void;
  const opts = typeof options === 'function' ? {} : options;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      done(err, '', 0);
      return;
    }
    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked) {
      done(
        new SsrfBlockedError(
          `Refusing to connect to a private or internal address (${blocked.address}).`
        ) as NodeJS.ErrnoException,
        '',
        0
      );
      return;
    }
    done(null, addresses[0].address, addresses[0].family);
  });
};

// Shared, long-lived dispatcher that pins connections to validated IPs.
const ssrfAgent = new Agent({ connect: { lookup: validatingLookup } });

type SafeFetchInit = Parameters<typeof fetch>[1] & {
  dispatcher?: Dispatcher;
};

// fetch() for user-supplied URLs. Re-validates every redirect hop (so a public
// URL cannot bounce to an internal address) and, unless the operator opted out,
// routes through the IP-pinning dispatcher above to defeat DNS rebinding.
export const safeFetch = async (
  url: string,
  init: SafeFetchInit = {}
): Promise<Response> => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertUrlAllowed(current);
    const res = await fetch(current, {
      ...init,
      redirect: 'manual',
      ...(config.booru.allowPrivateHosts ? {} : { dispatcher: ssrfAgent })
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError('Too many redirects');
};
