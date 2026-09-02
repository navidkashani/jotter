/**
 * Building jotter from an Open Publish snapshot.
 *
 * The scripts under `scripts/` are the only part of this repository that talks
 * to a network, rewrites `jotter.config.ts` and deletes a directory, so they
 * are tested against a real bucket rather than a mocked reader: a `node:http`
 * server on `127.0.0.1` speaking enough S3 to answer a GET. Path-style
 * addressing is the default, so `OP_ENDPOINT=http://127.0.0.1:<port>` reaches
 * it, and the server ignores the signature: what is being tested here is what
 * the build does with a snapshot, not whether SigV4 works, which the first
 * block below covers on its own.
 *
 * The seam these scripts exist to use is `src/lib/links-index.ts`, and the
 * shapes on either side of it are asserted here rather than described: the
 * plugin's `SnapshotLink` and jotter's `IndexedLink` are field for field the
 * same record, and `parseLinksIndex` already accepts the manifest's own
 * `{ links: {...} }` envelope.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { S3Reader, uriEncode } from '../scripts/lib/s3.mjs'
import {
  applyNoteMetadata,
  entryProblem,
  escapesVault,
  oldAddressesFor,
  reKeyLinks,
} from '../scripts/lib/snapshot.mjs'
import { ANALYTICS_PROVIDERS, mapSite, renderConfig } from '../scripts/lib/site-config.mjs'
import { resolveSiteUrl } from '../scripts/lib/site-url.mjs'

import { parseLinksIndex } from '../src/lib/links-index.js'
import { analyticsProviders, defineConfig } from '../src/lib/config.js'
import { buildRedirects } from '../src/lib/redirects.js'
import type { VaultNote } from '../src/lib/vault.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FETCH_CONTENT = join(ROOT, 'scripts', 'fetch-content.mjs')

/* -------------------------------------------------------------- signing */

describe('the S3 reader signs what the plugin signs', () => {
  const config = {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'my-notes',
    region: 'auto',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    prefix: '',
    forcePathStyle: true,
  }

  /**
   * AWS's own example credentials and clock, from the SigV4 "GET Object"
   * reference. The published signature there covers a request carrying a
   * `Range` header, which this reader never sends, so the *signature* below is
   * this implementation's own: pinned as a drift guard. Everything AWS does
   * fix is asserted: the empty-payload hash, the timestamp format, the
   * credential scope and the signed-header list, in order.
   */
  it('reproduces the AWS reference request, header for header', () => {
    const reader = new S3Reader({
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      bucket: '',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      prefix: '',
      forcePathStyle: false,
    })
    const headers = reader.sign(
      'GET',
      'https://examplebucket.s3.amazonaws.com/test.txt',
      new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
    )

    expect(headers['x-amz-date']).toBe('20130524T000000Z')
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=df548e2ce037944d03f3e68682813b093763996d597cf890ca3d9037fd231eb4',
    )
  })

  /**
   * The subtle half, and the one a stray `encodeURIComponent` would break:
   * AWS's URI encoding escapes everything outside the unreserved set, byte by
   * byte over UTF-8, in uppercase hex.
   */
  it('encodes the way AWS does, not the way JavaScript does', () => {
    expect(uriEncode('a/b c')).toBe('a%2Fb%20c')
    expect(uriEncode('a/b c', false)).toBe('a/b%20c')
    expect(uriEncode('café')).toBe('caf%C3%A9')
    expect(uriEncode('-_.~')).toBe('-_.~')
  })

  it('builds path-style and virtual-host URLs, prefixes and all', () => {
    expect(new S3Reader(config).url('current.json')).toBe(
      'https://acct.r2.cloudflarestorage.com/my-notes/current.json',
    )
    expect(new S3Reader({ ...config, prefix: 'sites/notes' }).url('current.json')).toBe(
      'https://acct.r2.cloudflarestorage.com/my-notes/sites/notes/current.json',
    )
    expect(new S3Reader({ ...config, forcePathStyle: false }).url('current.json')).toBe(
      'https://my-notes.acct.r2.cloudflarestorage.com/current.json',
    )
  })

  it('names every variable that is missing, and no others', () => {
    expect(() => S3Reader.fromEnv({ OP_ENDPOINT: 'https://e' })).toThrow(
      /OP_BUCKET.*OP_ACCESS_KEY_ID.*OP_SECRET_ACCESS_KEY/,
    )
    expect(() => S3Reader.fromEnv({ OP_ENDPOINT: 'https://e' })).not.toThrow(/OP_ENDPOINT/)
  })

  it('a 403 fails immediately rather than retrying against a revoked token', async () => {
    let attempts = 0
    const reader = new S3Reader(config)
    await expect(
      reader.get('current.json', {
        fetchImpl: async () => {
          attempts++
          return { status: 403, ok: false, arrayBuffer: async () => new ArrayBuffer(0) }
        },
      }),
    ).rejects.toThrow(/rejected the build credentials/)
    expect(attempts).toBe(1)
  })

  it('a missing key is null, and a transient failure is retried', async () => {
    const reader = new S3Reader(config)
    expect(
      await reader.get('nope', {
        fetchImpl: async () => ({ status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) }),
      }),
    ).toBe(null)

    let attempts = 0
    const body = await reader.get('current.json', {
      fetchImpl: async () => {
        if (++attempts < 3) throw new Error('socket hang up')
        return { status: 200, ok: true, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }
      },
    })
    expect(body?.toString()).toBe('{}')
    expect(attempts).toBe(3)
  })
})

/* ---------------------------------------------------------- path safety */

describe('a snapshot is checked before anything is written', () => {
  const file = { hash: 'a'.repeat(64), size: 1, mtime: 0, slug: 'notes/plain' }

  it('refuses a slug that would escape the vault', () => {
    expect(escapesVault('../outside')).toBe(true)
    expect(escapesVault('/etc/passwd')).toBe(true)
    expect(escapesVault('a/./b')).toBe(true)
    expect(escapesVault('notes/plain')).toBe(false)
    expect(escapesVault('Wisdom+&+Approaches/Critical+Thinking')).toBe(false)
  })

  it('names the file when its slug escapes', () => {
    expect(entryProblem('Notes/Plain.md', { ...file, slug: '../escape' })).toMatch(
      /"Notes\/Plain\.md".*escapes the vault directory: \.\.\/escape/,
    )
  })

  it('names the file when its own path escapes', () => {
    expect(entryProblem('../Plain.md', file)).toMatch(/escapes the vault directory/)
  })

  it('names the file when an old URL escapes', () => {
    expect(entryProblem('Notes/Plain.md', { ...file, legacyUrls: ['/etc/passwd'] })).toMatch(
      /old URL that escapes/,
    )
  })

  it('names the file when a rename comes from an escaping path', () => {
    expect(entryProblem('Notes/Plain.md', file, ['../elsewhere'])).toMatch(/redirect to "notes\/plain"/)
  })

  it('refuses an entry with no slug at all', () => {
    expect(entryProblem('Notes/Plain.md', { ...file, slug: '' })).toMatch(/no slug/)
  })

  /** No hash means nothing to fetch and nothing to check the bytes against. */
  it('refuses an entry whose hash is missing or malformed', () => {
    expect(entryProblem('Notes/Plain.md', { ...file, hash: undefined })).toMatch(/no usable sha256/)
    expect(entryProblem('Notes/Plain.md', { ...file, hash: 'not-a-hash' })).toMatch(/no usable sha256/)
  })

  it('passes a well-formed entry', () => {
    expect(entryProblem('Notes/Plain.md', file, ['old/name'])).toBeUndefined()
  })
})

/* ------------------------------------------------------------ the seam */

describe('the link index is re-keyed to the path jotter looks notes up by', () => {
  const snapshot = {
    files: {
      'Notes/Plain.md': { slug: 'notes/plain' },
      'Drafts/Secret.md': { slug: 'drafts/secret' },
    },
    links: {
      'Notes/Plain.md': [
        { raw: 'Secret', target: 'Drafts/Secret.md', status: 'unpublished' },
        { raw: 'Plain', target: 'Notes/Plain.md', status: 'published', slug: 'notes/plain' },
      ],
      'Nowhere/Gone.md': [{ raw: 'Anything', target: null, status: 'unresolved' }],
    },
  }

  /**
   * The re-keying is the whole reason this function exists. jotter looks the
   * index up by the note's **on-disk path**, which after fetch-content is
   * `<slug>.md`, not the vault path the manifest is keyed by. Left alone, every
   * lookup misses and the index silently does nothing.
   */
  it('keys by the file jotter will read, not the file Obsidian had', () => {
    expect(Object.keys(reKeyLinks(snapshot))).toEqual(['notes/plain.md'])
  })

  it('drops a note the snapshot has links for but no file', () => {
    expect(reKeyLinks(snapshot)['Nowhere/Gone.md']).toBeUndefined()
  })

  /**
   * The manifest's own envelope, straight into jotter's parser, with no
   * translation step in between: `parseLinksIndex` accepts `{ links: {...} }`,
   * and `SnapshotLink` is field for field `IndexedLink`.
   */
  it('is read back by src/lib/links-index.ts exactly as written', () => {
    const written = JSON.stringify({ links: reKeyLinks(snapshot) })
    const warnings: string[] = []
    const index = parseLinksIndex(written, warnings)

    expect(warnings).toEqual([])
    expect(index?.lookup('notes/plain.md', 'Plain')).toMatchObject({
      status: 'published',
      slug: 'notes/plain',
    })
    expect(index?.lookup('notes/plain.md', 'Secret')?.status).toBe('unpublished')
    expect(index?.lookup('notes/plain.md', 'Nothing')).toBeUndefined()
  })
})

/**
 * The decision this whole layer turns on: an old address is an `aliases:`
 * entry, never a `permalink:`. A permalink is where a note is *served*, so
 * writing the old URL there would move the note onto its own history: the
 * address the plugin published would 301 to the address the site used to have,
 * backwards. As an alias it is a 301 **to** the published slug, and the note
 * does not move.
 */
describe('an old address 301s to the note without moving it', () => {
  const note = (fields: Partial<VaultNote> & { slug: string }): VaultNote =>
    ({ path: `${fields.slug}.md`, aliases: [], permalinks: [], ...fields }) as VaultNote

  it('serves the Obsidian Publish URL as a redirect, percent-encoded once', () => {
    const notes = [
      note({
        slug: 'wisdom-approaches/critical-thinking',
        aliases: ['Wisdom+&+Approaches/Critical+Thinking'],
      }),
    ]
    const out = buildRedirects({ notes, taken: [notes[0].slug], slugs: 'preserve' })

    expect(out['/Wisdom+%26+Approaches/Critical+Thinking']).toBe(
      '/wisdom-approaches/critical-thinking',
    )
    // The note itself is untouched: nothing redirects away from its own slug.
    expect(out['/wisdom-approaches/critical-thinking']).toBeUndefined()
  })

  it('collects old addresses from the file and from every rename', () => {
    const file = { slug: 'notes/plain', legacyUrls: ['Notes/Plain'] }
    const redirects = [
      { from: '/old/name', to: 'notes/plain' },
      { from: 'other', to: 'somewhere/else' },
    ]
    expect(oldAddressesFor(file, 'notes/plain', redirects)).toEqual(['Notes/Plain', 'old/name'])
  })
})

/* ---------------------------------------------------------- frontmatter */

describe('frontmatter carries the title and every name the note answers to', () => {
  it('adds a block to a note that has none', () => {
    const out = applyNoteMetadata('# Plain\n\nBody.\n', { title: 'Plain', aliases: ['Old'] })
    expect(out).toBe('---\ntitle: "Plain"\naliases: ["Old"]\n---\n\n# Plain\n\nBody.\n')
  })

  it('leaves a note with nothing to add exactly as it was', () => {
    const text = '---\ntitle: Kept\n---\n\nBody.\n'
    expect(applyNoteMetadata(text, { title: 'Kept' })).toBe(text)
  })

  it('never overwrites a title the author wrote', () => {
    const out = applyNoteMetadata('---\ntitle: Mine\n---\n\nBody.\n', { title: 'Theirs' })
    expect(out).toContain('title: Mine')
    expect(out).not.toContain('Theirs')
  })

  /**
   * The one key that merges rather than yields, and it is not an exception to
   * "the author wins": the snapshot's `aliases` are read out of this very
   * frontmatter by the plugin, so the merged list is a superset of what the
   * author typed. Dropping the old addresses because the author happened to
   * keep an alias of their own is how a legacy URL silently stops answering.
   */
  it('merges old addresses into an aliases list the author already had', () => {
    const out = applyNoteMetadata(
      '---\ntitle: Critical Thinking\naliases:\n  - Crit\n---\n\nBody.\n',
      { title: 'Critical Thinking', aliases: ['Crit', 'Wisdom+&+Approaches/Critical+Thinking'] },
    )
    expect(out).toMatch(/aliases:/)
    expect(out).toContain('Crit')
    expect(out).toContain('Wisdom+&+Approaches/Critical+Thinking')
    expect(out.endsWith('\n\nBody.\n')).toBe(true)
  })

  it('merges into the singular `alias` spelling when that is the one in use', () => {
    const out = applyNoteMetadata('---\nalias: Crit\n---\n\nBody.\n', {
      aliases: ['Crit', 'Old/Address'],
    })
    expect(out).toContain('Old/Address')
    expect(out).not.toContain('aliases:')
  })

  it('leaves unterminated frontmatter alone rather than guessing where it ends', () => {
    const text = '---\ntitle: Broken\n\nBody with no close.\n'
    expect(applyNoteMetadata(text, { title: 'Other', aliases: ['X'] })).toBe(text)
  })

  it('says so when frontmatter it cannot parse costs the note its old addresses', () => {
    const warnings: string[] = []
    const text = '---\naliases: [unclosed\n---\n\nBody.\n'
    expect(applyNoteMetadata(text, { aliases: ['Old'] }, warnings)).toBe(text)
    expect(warnings[0]).toMatch(/old addresses were not added as aliases/)
  })
})

/* ------------------------------------------------------- site → config */

describe('site options become a jotter config', () => {
  const site = {
    title: 'My Notes',
    homepage: 'Notes/Home.md',
    locale: 'en-US',
    dir: 'ltr',
    noIndex: false,
    showThemeToggle: true,
    strictLineBreaks: false,
    showNavigation: true,
    showSearch: true,
    showGraph: false,
    showOutline: true,
    showBacklinks: true,
    showTags: true,
    analytics: { provider: 'none', id: '' },
  }

  it('maps the eight that map cleanly', () => {
    const { options } = mapSite({ ...site, noIndex: true, strictLineBreaks: true })
    expect(options.title).toBe('My Notes')
    expect(options.noIndex).toBe(true)
    expect(options.strictLineBreaks).toBe(true)
    expect(options.features).toMatchObject({
      toc: true,
      backlinks: true,
      tags: true,
      themeToggle: true,
      search: true,
    })
  })

  it('always preserves the addresses the plugin published', () => {
    expect(mapSite(site).options.slugs).toBe('preserve')
  })

  /**
   * The pair that makes a Persian vault publishable at all. Both are carried
   * across rather than re-derived: the plugin decides which languages read
   * right to left, and a second opinion here is a second answer to a settled
   * question.
   */
  it('carries the language and its direction straight across', () => {
    const { options } = mapSite({ ...site, locale: 'fa-IR', dir: 'rtl' })
    expect(options.locale).toBe('fa-IR')
    expect(options.dir).toBe('rtl')
  })

  it('refuses a direction that is not one of the two, rather than passing it on', () => {
    // `config.dir` is a zod enum, so anything else fails the *build*, which is
    // the one thing a site option is never allowed to do.
    expect(mapSite({ ...site, dir: 'sideways' }).options.dir).toBe('ltr')
    expect(mapSite({ ...site, dir: undefined }).options.dir).toBe('ltr')
  })

  /**
   * Trap one. `astro.config.ts:229` gates the graph island on
   * `features.graph && layout === 'panels'`, because the graph lives in the
   * right panel and the column layout has none. Asking for a graph and getting
   * `layout: 'column'` is a flag that is on and a feature that never renders.
   */
  it('gives the graph the layout it needs, and says so', () => {
    const on = mapSite({ ...site, showGraph: true })
    expect(on.options.features?.graph).toBe(true)
    expect(on.options.layout).toBe('panels')
    expect(on.notes.join(' ')).toMatch(/panels/)

    expect(mapSite({ ...site, showGraph: false }).options.layout).toBe('column')
  })

  /**
   * Trap two, and the only one that fails a build rather than looking wrong:
   * the plugin defaults `id` to `''`, and `src/lib/config.ts` refines `id` as
   * required unless the provider is `none`.
   */
  it('falls back to no analytics when the id is blank, loudly', () => {
    const { options, warnings } = mapSite({
      ...site,
      analytics: { provider: 'plausible', id: '' },
    })
    expect(options.analytics).toEqual({ provider: 'none' })
    expect(warnings.join(' ')).toMatch(/no site id/)
    expect(() => defineConfig(options)).not.toThrow()
  })

  it('keeps analytics that are actually configured', () => {
    const { options, warnings } = mapSite({
      ...site,
      analytics: { provider: 'plausible', id: 'notes.example.com' },
    })
    expect(options.analytics).toEqual({ provider: 'plausible', id: 'notes.example.com' })
    expect(warnings).toEqual([])
  })

  it('refuses a provider jotter cannot emit rather than dying on it', () => {
    const { options, warnings } = mapSite({
      ...site,
      analytics: { provider: 'matomo', id: 'x' },
    })
    expect(options.analytics).toEqual({ provider: 'none' })
    expect(warnings.join(' ')).toMatch(/matomo/)
  })

  /**
   * The list in `scripts/lib/site-config.mjs` is a copy, because a `.mjs`
   * script cannot import a `.ts` module. This is what stops the copy drifting:
   * a provider added to `src/lib/config.ts` and missed there would otherwise be
   * a build that dies on a zod enum error naming a key nobody typed.
   */
  it('knows exactly the providers src/lib/config.ts knows', () => {
    expect(ANALYTICS_PROVIDERS).toEqual([...analyticsProviders])
  })

  /** Trap three: a boolean here, a three-valued enum there. */
  it('turns the navigation boolean into the enum jotter takes', () => {
    expect(mapSite({ ...site, showNavigation: true }).options.nav).toBe('tree')
    expect(mapSite({ ...site, showNavigation: false }).options.nav).toBe('none')
  })

  /**
   * `homepage` is a vault path, and the plugin has already applied it by giving
   * that note the slug `index`, which `src/lib/site.ts:86` picks up on its own.
   * Copying it into `config.homepage` (which takes a *slug*) would be a
   * second answer to a settled question, and a wrong one.
   */
  it('does not re-apply the homepage the plugin already applied', () => {
    expect(mapSite(site).options).not.toHaveProperty('homepage')
  })

  /** An older plugin does not carry keys added since, and `undefined` is falsy. */
  it('keeps a missing key at its default rather than switching the feature off', () => {
    const { options } = mapSite({ title: 'Sparse' })
    expect(options.features?.search).toBe(true)
    expect(options.features?.backlinks).toBe(true)
    expect(options.nav).toBe('tree')
    // Language and direction arrived after the first snapshots did, and a
    // manifest that predates them builds the site it always built.
    expect(options.locale).toBe('en')
    expect(options.dir).toBe('ltr')
  })

  it('reports a key it does not understand rather than guessing', () => {
    const { notes } = mapSite({ ...site, showStackedNotes: true })
    expect(notes.join(' ')).toMatch(/showStackedNotes/)
  })

  it('produces a config that parses, banner and all', () => {
    const { options } = mapSite(site, { url: 'https://notes.example.com' })
    expect(() => defineConfig(options)).not.toThrow()

    const source = renderConfig(options, { snapshot: '2026-08-29T00-00-00Z-abc123' })
    expect(source).toMatch(/Do not hand-edit/)
    expect(source).toMatch(/2026-08-29T00-00-00Z-abc123/)
    expect(source).toMatch(/import \{ defineConfig \} from '\.\/src\/lib\/config'/)
    const call = 'defineConfig('
    const body = source.slice(source.indexOf(call) + call.length, source.lastIndexOf(')'))
    expect(JSON.parse(body)).toEqual(options)
  })
})

/* ------------------------------------------------------------ site URL */

describe('the site URL comes back whole, or not at all', () => {
  it('prefers an explicit OP_SITE_URL over anything the host injected', () => {
    expect(
      resolveSiteUrl({ OP_SITE_URL: 'https://mine.example', CF_PAGES_URL: 'https://theirs.pages.dev' }).url,
    ).toBe('https://mine.example')
  })

  /** `config.url` is `z.url()`, so a bare host (which is what Vercel gives) fails the parse. */
  it('adds the scheme a bare host arrives without', () => {
    expect(resolveSiteUrl({ VERCEL_URL: 'my-site.vercel.app' }).url).toBe('https://my-site.vercel.app')
    expect(() => defineConfig({ url: resolveSiteUrl({ VERCEL_URL: 'x.vercel.app' }).url })).not.toThrow()
  })

  it('walks the hosts in order and drops the trailing slash', () => {
    expect(resolveSiteUrl({ CF_PAGES_URL: 'https://notes.pages.dev/' }).url).toBe('https://notes.pages.dev')
    expect(resolveSiteUrl({ DEPLOY_PRIME_URL: 'https://deploy--x.netlify.app' }).url).toBe(
      'https://deploy--x.netlify.app',
    )
    expect(resolveSiteUrl({ URL: 'https://x.netlify.app' }).url).toBe('https://x.netlify.app')
  })

  it('is undefined rather than empty when nothing is set', () => {
    expect(resolveSiteUrl({}).url).toBeUndefined()
    expect(resolveSiteUrl({ OP_SITE_URL: '   ' }).url).toBeUndefined()
  })

  /**
   * Workers Builds injects no address at all. Quartz would ship a feed and a
   * sitemap for `example.com`; jotter simply emits neither, so this warns where
   * the reference implementation fails the build.
   */
  it('warns on the one host that says nothing, without failing the build', () => {
    const { url, warning } = resolveSiteUrl({ WORKERS_CI: '1' })
    expect(url).toBeUndefined()
    expect(warning).toMatch(/OP_SITE_URL/)
  })
})

/* --------------------------------------------------------- end to end */

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

interface Fixture {
  files: Record<string, { body: string | Buffer; entry: Record<string, unknown> }>
  links?: Record<string, unknown[]>
  redirects?: { from: string; to: string }[]
  site?: Record<string, unknown>
  /** Overridden only to prove the version gate. */
  version?: number
}

/** A bucket holding one snapshot, served over loopback. */
async function bucket(fixture: Fixture, corrupt: string[] = [], missing: string[] = []) {
  const objects = new Map<string, Buffer>()
  const files: Record<string, unknown> = {}

  for (const [path, { body, entry }] of Object.entries(fixture.files)) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    const hash = sha256(buffer)
    files[path] = { hash, size: buffer.length, mtime: 0, ...entry }
    if (missing.includes(path)) continue
    objects.set(
      `objects/${hash.slice(0, 2)}/${hash}`,
      corrupt.includes(path) ? Buffer.from('tampered', 'utf8') : buffer,
    )
  }

  const snapshot = {
    version: fixture.version ?? 1,
    id: '2026-08-29T09-00-00Z-fixture',
    parent: null,
    createdAt: 0,
    generator: { plugin: 'open-publish', version: 'test' },
    site: fixture.site ?? { title: 'Fixture Garden' },
    files,
    links: fixture.links ?? {},
    redirects: fixture.redirects ?? [],
  }

  const keys = new Map<string, Buffer>([
    ...objects,
    ['current.json', Buffer.from(JSON.stringify({ version: 1, snapshot: snapshot.id, updatedAt: 0 }))],
    [`snapshots/${snapshot.id}.json`, Buffer.from(JSON.stringify(snapshot))],
  ])

  const server: Server = createServer((req, res) => {
    // Path style: /<bucket>/<key>. The signature is not checked: SigV4 has its
    // own tests above, and a bucket that verified it would only be testing them.
    const key = decodeURIComponent((req.url ?? '').replace(/^\/fixture\//, '').split('?')[0])
    const body = keys.get(key)
    if (!body) {
      res.statusCode = 404
      return res.end('not found')
    }
    res.statusCode = 200
    res.end(body)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    snapshotId: snapshot.id,
    env: {
      OP_ENDPOINT: `http://127.0.0.1:${port}`,
      OP_BUCKET: 'fixture',
      OP_ACCESS_KEY_ID: 'key',
      OP_SECRET_ACCESS_KEY: 'secret',
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const temporary: string[] = []

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'jotter-snapshot-'))
  temporary.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true })
})

/**
 * The real script, in a scratch working directory.
 *
 * Every path `fetch-content.mjs` touches is resolved against its cwd, which is
 * what keeps this from overwriting the `jotter.config.ts` of the repository it
 * is testing.
 */
function fetchContent(cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [FETCH_CONTENT], {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

describe('fetch-content, against a bucket', () => {
  it('does nothing at all when no OP_ variable is set', async () => {
    const cwd = await project()
    await mkdir(join(cwd, 'src', 'content', 'notes'), { recursive: true })
    await writeFile(join(cwd, 'src', 'content', 'notes', 'Kept.md'), '# Kept\n')

    const { code, out } = await fetchContent(cwd, {})

    expect(code).toBe(0)
    expect(out).toBe('')
    expect(existsSync(join(cwd, 'src', 'content', 'notes', 'Kept.md'))).toBe(true)
    expect(existsSync(join(cwd, 'jotter.config.ts'))).toBe(false)
    expect(existsSync(join(cwd, '.op-build-state.json'))).toBe(false)
  })

  /** A typo in one build setting must not quietly publish somebody else's notes. */
  it('stops and names what is missing when only some are set', async () => {
    const cwd = await project()
    const { code, out } = await fetchContent(cwd, { OP_ENDPOINT: 'https://e', OP_BUCKET: 'b' })

    expect(code).toBe(1)
    expect(out).toMatch(/OP_ACCESS_KEY_ID/)
    expect(out).toMatch(/OP_SECRET_ACCESS_KEY/)
  })

  it('writes notes at their slugs, attachments at their vault paths, and the link index', async () => {
    const cwd = await project()
    const vault = join(cwd, 'vault')
    const png = Buffer.from('89504e470d0a1a0a', 'hex')

    const store = await bucket({
      site: {
        title: 'Fixture Garden',
        homepage: 'Notes/Home.md',
        noIndex: false,
        showThemeToggle: true,
        strictLineBreaks: false,
        showNavigation: true,
        showSearch: true,
        showGraph: true,
        showOutline: true,
        showBacklinks: true,
        showTags: true,
        analytics: { provider: 'none', id: '' },
      },
      files: {
        'Notes/Home.md': {
          body: '# Home\n\nSee [[Critical Thinking]] and ![[My Diagram.png]].\n',
          entry: { slug: 'index', title: 'Home' },
        },
        'Wisdom & Approaches/Critical Thinking.md': {
          body: '---\naliases:\n  - Crit\n---\n\n# Critical Thinking\n\nBody.\n',
          entry: {
            slug: 'wisdom-approaches/critical-thinking',
            title: 'Critical Thinking',
            aliases: ['Crit'],
            legacyUrls: ['Wisdom+&+Approaches/Critical+Thinking'],
          },
        },
        'attachments/My Diagram.png': { body: png, entry: { slug: 'attachments/my-diagram.png' } },
      },
      links: {
        'Notes/Home.md': [
          {
            raw: 'Critical Thinking',
            target: 'Wisdom & Approaches/Critical Thinking.md',
            status: 'published',
            slug: 'wisdom-approaches/critical-thinking',
          },
        ],
      },
      redirects: [{ from: 'notes/home', to: 'index' }],
    })

    const { code, out } = await fetchContent(cwd, {
      ...store.env,
      JOTTER_VAULT_OVERRIDE: vault,
    })
    await store.close()

    expect(code, out).toBe(0)

    // Markdown at its slug.
    const home = await readFile(join(vault, 'index.md'), 'utf8')
    expect(home).toContain('title: "Home"')
    expect(home).toContain('See [[Critical Thinking]]') // the body is never rewritten
    expect(home).toContain('aliases: ["notes/home"]') // the rename, as an alias

    const critical = await readFile(
      join(vault, 'wisdom-approaches', 'critical-thinking.md'),
      'utf8',
    )
    expect(critical).toContain('Crit')
    expect(critical).toContain('Wisdom+&+Approaches/Critical+Thinking')

    /**
     * The attachment keeps its vault path. Slugged, `resolveAsset` would never
     * find it: that function matches an embed on the file's basename and does
     * not consult the link index, so `![[My Diagram.png]]` against a file
     * written as `my-diagram.png` resolves to nothing.
     */
    expect(existsSync(join(vault, 'attachments', 'My Diagram.png'))).toBe(true)
    expect(existsSync(join(vault, 'attachments', 'my-diagram.png'))).toBe(false)

    const index = JSON.parse(await readFile(join(vault, '.jotter', 'links.json'), 'utf8'))
    expect(Object.keys(index.links)).toEqual(['index.md'])
    expect(parseLinksIndex(JSON.stringify(index))?.lookup('index.md', 'Critical Thinking')).toMatchObject(
      { status: 'published', slug: 'wisdom-approaches/critical-thinking' },
    )

    const config = await readFile(join(cwd, 'jotter.config.ts'), 'utf8')
    expect(config).toMatch(/Do not hand-edit/)
    expect(config).toMatch(/"slugs": "preserve"/)
    expect(config).toMatch(/"layout": "panels"/) // showGraph came with it
    expect(out).toMatch(/REGENERATED/)

    expect(JSON.parse(await readFile(join(cwd, '.op-build-state.json'), 'utf8'))).toEqual({
      snapshot: store.snapshotId,
      noIndex: false,
    })
  })

  it('removes a note the snapshot no longer lists', async () => {
    const cwd = await project()
    const vault = join(cwd, 'vault')
    await mkdir(vault, { recursive: true })
    await writeFile(join(vault, 'gone.md'), '# Gone\n')

    const store = await bucket({
      files: { 'Kept.md': { body: '# Kept\n', entry: { slug: 'kept', title: 'Kept' } } },
    })
    const { code } = await fetchContent(cwd, { ...store.env, JOTTER_VAULT_OVERRIDE: vault })
    await store.close()

    expect(code).toBe(0)
    expect(existsSync(join(vault, 'gone.md'))).toBe(false)
    expect(existsSync(join(vault, 'kept.md'))).toBe(true)
  })

  /**
   * An empty index is not the same as no index: `parseLinksIndex` reports one
   * as unusable and warns, on every build, about a file this script wrote.
   */
  it('writes no link index at all when the snapshot resolved no links', async () => {
    const cwd = await project()
    const vault = join(cwd, 'vault')
    const store = await bucket({
      files: { 'Alone.md': { body: '# Alone\n', entry: { slug: 'alone', title: 'Alone' } } },
    })
    const { code, out } = await fetchContent(cwd, { ...store.env, JOTTER_VAULT_OVERRIDE: vault })
    await store.close()

    expect(code, out).toBe(0)
    expect(existsSync(join(vault, '.jotter', 'links.json'))).toBe(false)
    expect(out).toMatch(/resolved no links/)
  })

  it('fails, naming the file, when an object comes back corrupted', async () => {
    const cwd = await project()
    const store = await bucket(
      { files: { 'Notes/Plain.md': { body: '# Plain\n', entry: { slug: 'notes/plain' } } } },
      ['Notes/Plain.md'],
    )
    const { code, out } = await fetchContent(cwd, {
      ...store.env,
      JOTTER_VAULT_OVERRIDE: join(cwd, 'vault'),
    })
    await store.close()

    expect(code).toBe(1)
    expect(out).toMatch(/Notes\/Plain\.md/)
    expect(out).toMatch(/corrupted/)
  })

  it('fails, naming the file, when an object is not in the bucket at all', async () => {
    const cwd = await project()
    const store = await bucket(
      { files: { 'Notes/Plain.md': { body: '# Plain\n', entry: { slug: 'notes/plain' } } } },
      [],
      ['Notes/Plain.md'],
    )
    const { code, out } = await fetchContent(cwd, {
      ...store.env,
      JOTTER_VAULT_OVERRIDE: join(cwd, 'vault'),
    })
    await store.close()

    expect(code).toBe(1)
    expect(out).toMatch(/Notes\/Plain\.md/)
    expect(out).toMatch(/missing from storage/)
  })

  /** Checked before anything is deleted, so a bad snapshot leaves the vault alone. */
  it('refuses an escaping slug and leaves the vault untouched', async () => {
    const cwd = await project()
    const vault = join(cwd, 'vault')
    await mkdir(vault, { recursive: true })
    await writeFile(join(vault, 'existing.md'), '# Existing\n')

    const store = await bucket({
      files: {
        'Notes/Plain.md': { body: '# Plain\n', entry: { slug: '../escape' } },
        'Notes/Other.md': { body: '# Other\n', entry: { slug: '/rooted' } },
      },
    })
    const { code, out } = await fetchContent(cwd, { ...store.env, JOTTER_VAULT_OVERRIDE: vault })
    await store.close()

    expect(code).toBe(1)
    expect(out).toMatch(/\.\.\/escape/)
    expect(out).toMatch(/\/rooted/)
    expect(existsSync(join(vault, 'existing.md'))).toBe(true)
  })

  /**
   * The plugin refuses a slug collision at scan time, so this should be
   * unreachable, and the only other symptom is a note that silently is not on
   * the site, resolved by whichever download finished last.
   */
  it('refuses two entries that would be written to one file', async () => {
    const cwd = await project()
    const store = await bucket({
      files: {
        'Notes/One.md': { body: '# One\n', entry: { slug: 'same' } },
        'Notes/Two.md': { body: '# Two\n', entry: { slug: 'same' } },
      },
    })
    const { code, out } = await fetchContent(cwd, {
      ...store.env,
      JOTTER_VAULT_OVERRIDE: join(cwd, 'vault'),
    })
    await store.close()

    expect(code).toBe(1)
    expect(out).toMatch(/Notes\/One\.md/)
    expect(out).toMatch(/Notes\/Two\.md/)
  })

  it('refuses a snapshot version it does not understand', async () => {
    const cwd = await project()
    const store = await bucket({
      version: 2,
      files: { 'A.md': { body: '# A\n', entry: { slug: 'a' } } },
    })
    const { code, out } = await fetchContent(cwd, {
      ...store.env,
      JOTTER_VAULT_OVERRIDE: join(cwd, 'vault'),
    })
    await store.close()

    expect(code).toBe(1)
    expect(out).toMatch(/version 2/)
    expect(out).toMatch(/Update this repository/)
  })

  /** Nothing published yet reads as an empty bucket, not as a crash. */
  it('says so when the bucket holds no publish at all', async () => {
    const cwd = await project()
    const store = await bucket({ files: { 'A.md': { body: '# A\n', entry: { slug: 'a' } } } })
    const { code, out } = await fetchContent(cwd, {
      ...store.env,
      OP_PREFIX: 'never-published',
      JOTTER_VAULT_OVERRIDE: join(cwd, 'vault'),
    })
    await store.close()

    expect(code).toBe(1)
    expect(out).toMatch(/No content has been published yet/)
  })
})
