/**
 * Astro keeps the content-collection store in *two* places, and which one is
 * live depends on the command.
 *
 * From `astro/dist/content/paths.js`:
 *
 *   getDataStoreFile(settings, isDev) {
 *     return new URL(DATA_STORE_FILE, isDev ? settings.dotAstroDir : settings.config.cacheDir)
 *   }
 *
 * with `dotAstroDir = new URL('.astro/', config.root)`. So `astro dev` reads
 * and writes `<root>/.astro/data-store.json`, and `astro build` reads and
 * writes `cacheDir`, which defaults to `node_modules/.astro/`. Verified rather
 * than inferred: delete the build store, run `astro build`, and it comes back
 * while the dev store's mtime does not move at all.
 *
 * Why any of this matters is the part that costs an afternoon if it is not
 * written down. The content layer invalidates a cached render on the *source
 * file's* digest. Change the markdown pipeline instead — a plugin, or a
 * `jotter.config.ts` feature flag that a plugin reads — and every digest is
 * unchanged, so every note is served from cache and the change appears to have
 * done nothing. `astro dev --force` does not help; neither does restarting the
 * server. Only removing the store does.
 *
 * That is why `verify --full` clears before each of its rebuilds: it rewrites
 * `jotter.config.ts` on purpose, which is exactly the kind of change no digest
 * notices. It clears both, not just the build store, because it leaves the
 * pipeline changed behind it and the next `astro dev` would otherwise serve a
 * store rendered under the old one.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Project-relative, dev store first. Both are gitignored and regenerated. */
export const CONTENT_STORES = ['.astro', 'node_modules/.astro']

/**
 * Remove both stores, so the next `astro dev` *and* the next `astro build`
 * re-render from source.
 *
 * @param {string} root Absolute path to the project root.
 */
export async function clearContentStores(root) {
  for (const store of CONTENT_STORES) {
    await rm(join(root, store), { recursive: true, force: true })
  }
}
