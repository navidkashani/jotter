/**
 * The Workers Builds config, checked against what the build actually produces.
 *
 * Nothing in `wrangler.jsonc` fails a build when it is wrong, which is the
 * whole reason it is worth a test. Point `assets.directory` somewhere the build
 * does not write and Workers deploys an empty site, successfully. Leave
 * `html_handling` at its default and it deploys a site where every internal
 * link is a redirect to an address the canonical, the sitemap and the search
 * index all disagree with. Both are silent, and `npm run verify` cannot see
 * either: it reads `dist/`, and this file is not in it.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

interface WranglerConfig {
  name?: string
  main?: string
  compatibility_date?: string
  pages_build_output_dir?: string
  assets: {
    directory: string
    not_found_handling: string
    html_handling: string
  }
}

/**
 * Comments are the point of using .jsonc, so they have to come back out before
 * `JSON.parse` sees it. Whole-line comments only, which is all the file uses,
 * so a `//` inside a string value cannot be mangled by this.
 */
const readJsonc = (file: string): WranglerConfig =>
  JSON.parse(
    read(file)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n'),
  )

const config = readJsonc('wrangler.jsonc')
const astroConfig = read('astro.config.ts')

/** `./dist`, `dist` and `dist/` are one directory; the comparison should agree. */
const normalize = (dir: string) => dir.replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * Where `astro build` writes, worked out the way Astro works it out: the
 * `outDir` the config names, or Astro's default when it names none.
 */
const outDir = /^\s*outDir:\s*['"]([^'"]+)['"]/m.exec(astroConfig)?.[1] ?? 'dist'

describe('the Workers Builds config matches the build', () => {
  it('uploads the directory the build actually writes', () => {
    // The silent one. Every other value here is wrong loudly, or wrong in a way
    // a reader of the deployed site notices; this one ships nothing at all and
    // reports success.
    expect(normalize(config.assets.directory)).toBe(normalize(outDir))
  })

  it('names the same directory the scripts after the build read', () => {
    // And this is what makes the default above mean something: `outDir` is not
    // set, so the line under test is agreement between four files rather than
    // agreement between `wrangler.jsonc` and a constant in this test. Setting
    // `outDir` fails here too, so all four move together or none do.
    for (const script of ['scripts/verify-build.mjs', 'scripts/finalize.mjs']) {
      const named = /^const DIST = join\(ROOT, '([^']+)'\)/m.exec(read(script))?.[1]
      expect(named, `${script} names no DIST to compare`).toBe(normalize(outDir))
    }
  })

  it('serves pages at the address the rest of the build spells', () => {
    // `trailingSlash: 'never'` is what every link, canonical, sitemap entry and
    // search result in the site is built from, and "drop-trailing-slash" is the
    // half of that promise the host has to keep. `build.format` is deliberately
    // not asserted with it: this mode serves `foo.html` and `foo/index.html` at
    // the same extensionless address, so the file layout can change and only
    // the trailing slash decides.
    expect(config.assets.html_handling).toBe('drop-trailing-slash')
    expect(astroConfig).toMatch(/^\s*trailingSlash: 'never',$/m)
  })

  it('promises a 404 page the build emits', () => {
    expect(config.assets.not_found_handling).toBe('404-page')
    expect(
      existsSync(join(ROOT, 'src/pages/404.astro')),
      'or "404-page" points at a dist/404.html nothing writes',
    ).toBe(true)
  })

  it('declares no Worker code, because there is none', () => {
    expect(
      'main' in config,
      'a script here would stop _headers applying to the responses it answered',
    ).toBe(false)
    expect(config.name, 'Workers Builds fails when this and the dashboard disagree').toBeTruthy()
    expect(
      config.compatibility_date,
      'pinned, so runtime behaviour does not move because a rebuild ran later',
    ).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('stays invisible to Cloudflare Pages', () => {
    // Without `pages_build_output_dir` a Wrangler file is used for local
    // development only, which is what lets one repository serve both hosts.
    // Adding that key would silently take over the build settings of every
    // Pages project already deployed from this theme, and `wrangler deploy`
    // would start warning that this is a Pages project and asking whether to
    // proceed. The price of leaving it out is a warning in the Pages build log,
    // which `wrangler.jsonc` quotes and `docs/open-publish.md` explains.
    expect('pages_build_output_dir' in config).toBe(false)
  })
})
