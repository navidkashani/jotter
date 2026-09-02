/**
 * Click-to-play: the only moment jotter ever loads a third party.
 *
 * Like `hover-preview.ts` and `local-graph.ts`, this is the browser side of the
 * boundary. Nothing here may import from `src/lib/` (that is build-time code
 * and it reaches for `node:fs`), and nothing here is imported by a page.
 *
 * The page it runs on already works. `src/markdown/wikilinks.ts` renders every
 * remote video as a poster inside a link to the video, so with JavaScript off,
 * before this file has loaded, or after it has thrown, the facade is a link
 * that goes where the reader expected. This upgrades that link; it does not
 * create it.
 *
 * **The click is the consent.** The built HTML contains no `<iframe>`, no
 * script and no image from anybody else's origin, which is what lets the
 * origin assertion in `scripts/verify-build.mjs` stay an assertion rather than
 * an assertion with a YouTube-shaped hole in it. Until a reader asks for the
 * video, nothing has been requested on their behalf.
 *
 * `youtube-nocookie.com` rather than `youtube.com`, so YouTube sets no cookie
 * until the video actually plays, and `autoplay=1` because the reader has just
 * clicked a play button and a second click would be a bug.
 */

/** One delegated listener on the document, not one per facade. */
const SELECTOR = '.video-embed[data-embed]'

interface Facade {
  kind: string
  id: string
  playlist: boolean
}

function read(element: HTMLElement): Facade | undefined {
  const kind = element.dataset.embed
  const id = element.dataset.embedId
  if (!kind || !id) return undefined
  return { kind, id, playlist: element.dataset.embedPlaylist !== undefined }
}

/**
 * The player URL, built here rather than written into the markup.
 *
 * The string is in `dist/` either way, inside this script; what must not be
 * there is an `<iframe src>` carrying it, because that is a request rather than
 * a recipe. `scripts/verify-build.mjs` asserts exactly that distinction, and
 * building the URL at click time is what keeps the assertion honest instead of
 * technically satisfied.
 */
function playerSrc({ kind, id, playlist }: Facade): string | undefined {
  if (kind === 'youtube') {
    const base = 'https://www.youtube-nocookie.com/embed/'
    return playlist
      ? `${base}videoseries?list=${encodeURIComponent(id)}&autoplay=1`
      : `${base}${encodeURIComponent(id)}?autoplay=1`
  }
  if (kind === 'vimeo') {
    return `https://player.vimeo.com/video/${encodeURIComponent(id)}?autoplay=1`
  }
  return undefined
}

function play(element: HTMLElement): boolean {
  const facade = read(element)
  const src = facade && playerSrc(facade)
  if (!src) return false

  const frame = document.createElement('iframe')
  frame.className = 'video-embed-frame'
  frame.src = src
  /**
   * Named, because an `<iframe>` with no accessible name is announced as
   * "frame", which is the one thing a reader already knows. The label the
   * facade carried is the best name available without asking anybody.
   *
   * The label's *first* node, not its text: the rest of it is the
   * visually-hidden "(opens in a new tab)" the facade's anchor owed, and a
   * frame that has just replaced that anchor opens nothing.
   */
  const label = element.querySelector('.video-embed-label')?.firstChild?.textContent
  frame.title = label?.trim() || 'Video'
  frame.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture'
  frame.allowFullscreen = true
  frame.loading = 'eager'

  // The wrapper keeps its own box, so swapping the contents cannot move the
  // rest of the page: the aspect ratio is on `.video-embed` in the stylesheet.
  element.replaceChildren(frame)
  element.dataset.embedPlaying = ''
  frame.focus()
  return true
}

document.addEventListener('click', (event) => {
  // Anything but a plain primary click is the reader asking their browser for
  // something else: a new tab, a saved link, a context menu. The anchor under
  // the facade already does all of those correctly, so leave it alone.
  if (event.defaultPrevented) return
  const mouse = event as MouseEvent
  if (mouse.button !== 0 || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey) return

  const target = event.target
  if (!(target instanceof Element)) return
  const element = target.closest<HTMLElement>(SELECTOR)
  if (!element || element.dataset.embedPlaying !== undefined) return

  if (play(element)) event.preventDefault()
})
