import dns from 'node:dns/promises'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { AppError } from './ai.ts'

// Fail closed for special-use ranges, including IPv4-embedded IPv6 and
// transition mechanisms. Only native IPv6 global unicast is eligible.
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.175.48.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
blocked.addAddress('168.63.129.16', 'ipv4') // Azure platform virtual address
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['2620:4f:8000::', 48], ['3fff::', 20],
] as const) blocked.addSubnet(address, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicByokAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

const invalidUrl = () => new AppError(400, 'BYOK baseUrl must be an HTTPS public endpoint without credentials, query, or fragment.')

export function byokEndpoint(baseUrl: string | undefined): URL {
  if (!baseUrl || baseUrl.length > 2000 || /[\s\\?#]/.test(baseUrl)
    || !/^https:\/\/[^/]+(?:\/|$)/i.test(baseUrl)) throw invalidUrl()
  let url: URL
  try { url = new URL(baseUrl) } catch { throw invalidUrl() }
  // Reject even empty userinfo, rather than relying on URL normalization.
  if (url.protocol !== 'https:' || url.username || url.password || /^https:\/\/[^/]*@/i.test(baseUrl)) throw invalidUrl()
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || (isIP(hostname) && !isPublicByokAddress(hostname))) throw invalidUrl()
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
  return url
}

async function destination(hostname: string) {
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError(504, 'BYOK DNS lookup timed out. Try again.')), 5000)
      }),
    ])
    // Validate EVERY result, not just the address selected for this connection.
    if (!addresses.length || addresses.some(entry => !isPublicByokAddress(entry.address))) throw invalidUrl()
    return addresses[0]!
  } finally { clearTimeout(timer) }
}

/** Direct HTTPS only: no proxy environment, connection pooling, redirects, or retries. */
export async function requestByok(baseUrl: string | undefined, key: string, body: string): Promise<Response> {
  const url = byokEndpoint(baseUrl)
  const signal = AbortSignal.timeout(180_000)
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const pinned = await destination(hostname)
    return await new Promise<Response>((resolve, reject) => {
      const request = https.request(url, {
        method: 'POST', agent: false, signal, rejectUnauthorized: true,
        // Keep the original URL host for Host, SNI and certificate verification;
        // only socket resolution is replaced. Never resolve a second time.
        // A fixed family also disables Node's automatic family selection.
        family: pinned.family,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      }, response => {
        const status = response.statusCode || 502
        if (status < 200 || status >= 300) {
          // Do not consume, log, or forward provider errors or Location headers.
          response.destroy()
          // Node accepts nonstandard three-digit codes; the Fetch Response
          // constructor does not. Never throw out of an event callback.
          resolve(new Response(null, { status: status >= 300 && status <= 599 ? status : 502 }))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2 * 1024 * 1024) {
            reject(new AppError(502, 'The BYOK provider response was too large.'))
            response.destroy()
            request.destroy()
          } else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('aborted', () => reject(new Error('Aborted response')))
        response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: 200 })))
      })
      request.on('error', reject)
      request.end(body)
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    if (signal.aborted) throw new AppError(504, 'BYOK request timed out after 3 minutes. Try again.')
    throw new AppError(502, 'Cannot reach the BYOK provider. Check the endpoint and try again.')
  }
}
