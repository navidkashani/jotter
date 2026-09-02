/**
 * Read-only S3 client for the build environment.
 *
 * Ported from `starters/quartz/scripts/lib/s3.mjs` in open-publish, and kept
 * byte-compatible with it on purpose: `test/snapshot.test.ts` pins both ends
 * against the AWS reference vector, so two implementations of one spec cannot
 * drift in silence.
 *
 * Dependency-free, and that is a live concern here rather than a preference.
 * jotter installs with `npm ci --omit=dev` on a host that has never heard of
 * this repository (it is why `pagefind` is a production dependency), and a
 * signing library added for one GET would be a fourth thing to keep in step
 * with the plugin's signer. Node's own `crypto` and global `fetch` are enough.
 */

import { createHash, createHmac } from 'node:crypto'

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/

/**
 * AWS's own URI encoding, which is *not* `encodeURIComponent`: it escapes
 * everything outside the unreserved set, byte by byte over UTF-8, and spells
 * every escape in uppercase hex. A key with a space or a `café` in it signs
 * correctly only under this exact rule.
 */
export function uriEncode(input, encodeSlash = true) {
  let out = ''
  for (const byte of Buffer.from(input, 'utf8')) {
    const char = String.fromCharCode(byte)
    if (byte < 0x80 && UNRESERVED.test(char)) out += char
    else if (char === '/' && !encodeSlash) out += '/'
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

export const EMPTY_PAYLOAD_SHA256 = sha256('')

/** The four that must be present together, or not at all. See `fromEnv`. */
export const REQUIRED_ENV = [
  'OP_ENDPOINT',
  'OP_BUCKET',
  'OP_ACCESS_KEY_ID',
  'OP_SECRET_ACCESS_KEY',
]

export class S3Reader {
  constructor(config) {
    this.config = config
  }

  static fromEnv(env = process.env) {
    const missing = REQUIRED_ENV.filter((name) => !env[name])
    if (missing.length > 0) {
      throw new Error(
        `Missing environment variable(s): ${missing.join(', ')}.\n` +
          "Set these in your host's build settings (for Cloudflare Pages: Settings -> Environment " +
          'variables), using the read-only storage token from the Obsidian plugin.',
      )
    }
    return new S3Reader({
      endpoint: env.OP_ENDPOINT.replace(/\/+$/, ''),
      bucket: env.OP_BUCKET,
      region: env.OP_REGION || 'auto',
      accessKeyId: env.OP_ACCESS_KEY_ID,
      secretAccessKey: env.OP_SECRET_ACCESS_KEY,
      prefix: (env.OP_PREFIX || '').replace(/^\/+|\/+$/g, ''),
      forcePathStyle: env.OP_FORCE_PATH_STYLE !== 'false',
    })
  }

  url(key) {
    const fullKey = this.config.prefix ? `${this.config.prefix}/${key}` : key
    const endpoint = new URL(this.config.endpoint)
    const encoded = uriEncode(fullKey, false)
    if (!this.config.forcePathStyle) {
      return `${endpoint.protocol}//${this.config.bucket}.${endpoint.host}/${encoded}`
    }
    return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}/${this.config.bucket}/${encoded}`
  }

  /**
   * The signed headers for one request.
   *
   * @param {string} method
   * @param {string} urlString
   * @param {Date} [now]
   * @returns {Record<string, string>}
   */
  sign(method, urlString, now = new Date()) {
    const url = new URL(urlString)
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const stamp = amzDate.slice(0, 8)

    const headers = {
      host: url.host,
      'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
      'x-amz-date': amzDate,
    }
    const names = Object.keys(headers).sort()
    const canonicalRequest = [
      method,
      uriEncode(decodeURIComponent(url.pathname), false),
      '',
      names.map((n) => `${n}:${headers[n]}\n`).join(''),
      names.join(';'),
      EMPTY_PAYLOAD_SHA256,
    ].join('\n')

    const scope = `${stamp}/${this.config.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

    let key = Buffer.from(`AWS4${this.config.secretAccessKey}`, 'utf8')
    for (const part of [stamp, this.config.region, 's3', 'aws4_request']) key = hmac(key, part)

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(';')}, Signature=${hmac(key, stringToSign).toString('hex')}`
    return headers
  }

  /**
   * The object at `key`, or `null` when it does not exist.
   *
   * @param {string} key
   * @param {{ retries?: number, fetchImpl?: (url: string, init?: any) => Promise<any> }} [options]
   * @returns {Promise<Buffer | null>}
   */
  async get(key, { retries = 3, fetchImpl = fetch } = {}) {
    const url = this.url(key)
    let lastError

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchImpl(url, { headers: this.sign('GET', url) })
        if (response.status === 404) return null
        if (response.status === 403) {
          throw new Error(
            'Storage rejected the build credentials (403). Check OP_ACCESS_KEY_ID and ' +
              'OP_SECRET_ACCESS_KEY, and that the token is scoped to this bucket.',
          )
        }
        if (!response.ok) throw new Error(`Storage returned HTTP ${response.status} for ${key}`)
        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        lastError = error
        // Credential problems will not fix themselves; fail immediately.
        if (String(error.message).includes('403')) throw error
        if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      }
    }
    throw lastError
  }

  /**
   * @param {string} key
   * @param {{ retries?: number, fetchImpl?: (url: string, init?: any) => Promise<any> }} [options]
   * @returns {Promise<any>}
   */
  async getJson(key, options) {
    const body = await this.get(key, options)
    return body ? JSON.parse(body.toString('utf8')) : null
  }
}

export { sha256 }
