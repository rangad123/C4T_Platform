import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { LookupFunction } from 'node:net'

/**
 * Outbound HTTP to an address a customer typed in (their Jira site).
 *
 * A customer-supplied URL is a server-side request forgery risk: pointed at
 * 127.0.0.1, 169.254.169.254 or a 10.x host it would let a customer make this
 * server talk to things only it can reach. So:
 *
 *   - https only;
 *   - every address the host name resolves to must be public;
 *   - the check runs inside the socket's own DNS lookup, on every request, so
 *     the address that was checked IS the address connected to. A name that
 *     resolved to a public address at save time and to 127.0.0.1 now (DNS
 *     rebinding) is refused at connect;
 *   - redirects are not followed; a request times out.
 *
 * Tests run a fake Jira on loopback over plain http, so they switch the
 * check off with `setOutboundCheckForTests`. Nothing else may call it.
 */

const BLOCKED = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv6')
}

/** True for any address this server must not be made to call. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 0) return true
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4')
    if (/^::ffff:/i.test(address)) return true
    return BLOCKED.check(address, 'ipv6')
  }
  return BLOCKED.check(address, 'ipv4')
}

let testOverride = false

/** Tests only: allow http and loopback so a local fake server can be reached. */
export function setOutboundCheckForTests(off: boolean): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Outbound check override is for tests only')
  testOverride = off
}

export class OutboundError extends Error {}

/** Shape check, no DNS. Used at save time and before every request. */
export function assertSafeUrlShape(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundError('Enter a full https:// address')
  }
  if (url.username || url.password)
    throw new OutboundError('The address must not contain a user name or password')
  if (testOverride) return url
  if (url.protocol !== 'https:') throw new OutboundError('The address must start with https://')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new OutboundError('That address is private or local, so it cannot be reached from here')
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new OutboundError('That address is private or local, so it cannot be reached from here')
  }
  return url
}

/** Resolve every address and refuse if any is private. */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (testOverride) return
  const host = hostname.replace(/^\[|\]$/g, '')
  let addresses: { address: string }[]
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new OutboundError('That address could not be found')
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new OutboundError('That address is private or local, so it cannot be reached from here')
  }
}

/** The lookup the socket itself uses: refuses a private answer at connect time. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = addresses
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(
        new OutboundError('That address is private or local, so it cannot be reached from here'),
        '',
        0,
      )
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
    }
    callback(null, list[0]!.address, list[0]!.family)
  })
}

export interface OutboundResponse {
  status: number
  /** Parsed JSON body, or null. Never shown to a person as-is. */
  json: unknown
}

/** One JSON request. Bodies are capped at 1 MB; redirects are not followed. */
export async function outboundJson(
  rawUrl: string,
  init: {
    method: 'GET' | 'POST'
    headers: Record<string, string>
    body?: unknown
    timeoutMs?: number
  },
): Promise<OutboundResponse> {
  const url = assertSafeUrlShape(rawUrl)
  await assertPublicHost(url.hostname)
  const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body))
  const transport = url.protocol === 'https:' ? https : http

  return new Promise<OutboundResponse>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
            : {}),
          ...init.headers,
        },
        timeout: init.timeoutMs ?? 10_000,
        ...(testOverride ? {} : { lookup: guardedLookup }),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 1_000_000) {
            req.destroy(new OutboundError('The response was too large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new OutboundError('The request timed out')))
    req.on('error', (err) =>
      reject(
        err instanceof OutboundError ? err : new OutboundError('The address could not be reached'),
      ),
    )
    if (payload) req.write(payload)
    req.end()
  })
}
