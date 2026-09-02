/**
 * Hover previews: the card.
 *
 * Like `local-graph.ts`, this is the browser side of the boundary. Nothing here
 * may import from `src/lib/` (that is build-time code and it reaches for
 * `node:fs`), and nothing here is imported by a page.
 *
 * Everything it shows is already in the page. `src/markdown/wikilinks.ts` put
 * `data-preview-title` and `data-preview` on the anchor at build time, so there
 * is nothing to fetch, nothing to await, nothing to cache and no race to guard
 * against. Quartz's `popover.inline.ts` needs all four because it fetches; the
 * build asserts that jotter never does.
 *
 * Three things it takes from Quartz anyway: the card stays open while the
 * pointer is *on* it (WCAG 1.4.13 *hoverable*), the whole feature is off for
 * touch, and the delay is real hover intent rather than a CSS `animation-delay`:
 * Quartz's fetch still fires on every `mouseenter`; nothing happens here
 * until the intent is confirmed.
 *
 * 400ms is inside the researched band. Wikipedia settled on 500ms after A/B
 * tests on three wikis and Nielsen Norman recommends 300–500ms, scaled to how
 * disruptive the thing that appears is. This card is lighter than Wikipedia's
 * (no image, no scroll), and has no network latency to hide.
 */

const OPEN_DELAY = 400

/**
 * The grace period on the way out, so the pointer can cross the gap from the
 * link to the card. If bytes ever need cutting, cut the positioning fallbacks
 * before this: dropping the grace makes the feature non-conformant with WCAG
 * 1.4.13 rather than merely worse.
 */
const CLOSE_DELAY = 200

const ANCHOR = '--jotter-preview'

/**
 * Positioning is CSS anchor positioning, and the script sets one custom
 * property. That is ~350 bytes smaller than a hand-rolled flip-and-clamp, it
 * gets scroll-tracking and scroll-away hiding for free, and (the deciding
 * argument) `position-area` and `position-try-fallbacks` are *logical*, so RTL
 * is correct by construction. The JavaScript alternative wants
 * `getBoundingClientRect().left`, which is physically wrong in RTL and passes
 * the build's physical-property lint only because `.ts` files are not scanned.
 *
 * Without this guard an unsupporting browser falls back to the UA default and
 * parks the card dead-centre of the viewport. Failing to nothing is the idiom
 * here, and this is pure acceleration for pointer users: nothing is lost.
 */
if (CSS.supports('anchor-name', '--a')) setup()

function setup() {
  const card = document.createElement('div')
  card.className = 'note-preview'
  /**
   * `popover=auto` puts the card in the top layer, which sidesteps z-index the
   * same way `<dialog>` did for the graph, and brings Esc and light dismiss
   * with it: WCAG 1.4.13 *dismissible*, without focus ever entering the card.
   */
  card.popover = 'auto'
  /**
   * Pointer-only acceleration, and `aria-hidden` is the honest way to say so.
   * The excerpt is not new information: the destination is one click away and
   * fully announced there. A screen reader gets no benefit from this feature
   * and no noise from it either: a page sounds byte-identical with it on or
   * off, because `data-*` attributes never reach the accessibility tree.
   */
  card.setAttribute('aria-hidden', 'true')

  const heading = document.createElement('span')
  heading.className = 'note-preview-title'
  const body = document.createElement('span')
  body.className = 'note-preview-text'
  card.append(heading, body)
  document.body.append(card)

  /**
   * Two lifetimes, and they are deliberately different lengths.
   *
   * `active` is what the card is *showing*, and it is cleared the moment the
   * card closes so that hovering the same link again re-opens it.
   *
   * `anchored` is what carries `anchor-name`, and it outlives the close. The
   * card fades out over `--duration-fast`, and it is still on screen for that
   * whole time: strip the name at close and `position-anchor` stops resolving
   * mid-fade, `position-area` drops out with it, and `inset: auto` parks the
   * card at the viewport's top-left corner for the length of the transition.
   * So the name stays put until it is needed somewhere else.
   *
   * Only ever one element carries it. That is not tidiness, where two elements
   * share an anchor name the anchor resolves to the last of them in tree order,
   * so a leftover name earlier in the document is fine and a leftover name
   * *after* the current link would silently attach the card to the wrong one.
   */
  let active: HTMLElement | null = null
  let anchored: HTMLElement | null = null
  let timer = 0

  const schedule = (run: () => void, delay: number) => {
    clearTimeout(timer)
    timer = window.setTimeout(run, delay)
  }

  /**
   * Forget what is showing, without touching the popover or the anchor. Esc and
   * light dismiss hide the card without going through `close()`, and a stale
   * `active` would make that same link un-hoverable for the rest of the page's
   * life.
   */
  const reset = () => {
    active = null
  }

  const close = () => {
    clearTimeout(timer)
    /**
     * `togglePopover(false)`, never `hidePopover()`/`showPopover()`: the latter
     * pair throws `InvalidStateError` when the popover is already in the state
     * asked for, which is precisely what happens moving from link A to link B.
     * `togglePopover` is throw-free *and* smaller than guarding.
     */
    card.togglePopover(false)
    reset()
  }

  const open = (link: HTMLElement) => {
    // Re-point the anchor rather than clearing and re-setting it, so the card
    // is never anchorless for a frame on the way from link A to link B.
    if (anchored && anchored !== link) anchored.style.removeProperty('anchor-name')
    anchored = link
    link.style.setProperty('anchor-name', ANCHOR)
    active = link
    // `textContent`, not `innerHTML`. Nothing in `src/` uses `innerHTML`, and
    // two plain strings is the whole reason this needs no id rewriting.
    heading.textContent = link.dataset.previewTitle ?? ''
    body.textContent = link.dataset.preview ?? ''
    card.togglePopover(true)
  }

  const elementOf = (event: Event) => (event.target instanceof Element ? event.target : null)

  /**
   * Bound to `document` rather than to a container: the attribute is the gate,
   * and nothing outside prose carries one. `.note-body` would be the wrong
   * container anyway: `Note.astro` puts `<PrevNext>` inside it, which is why
   * `verify-build.mjs` has to split prose on `<nav class="prev-next">`.
   */
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return
    const over = elementOf(event)
    if (!over) return

    // Hoverable: the pointer may travel link -> card without it vanishing.
    if (card.contains(over)) return clearTimeout(timer)

    const link = over.closest<HTMLElement>('[data-preview]')
    if (!link) return
    // Moving within the link that is already showing: cancel the pending close,
    // do not re-open.
    if (link === active) return clearTimeout(timer)
    schedule(() => open(link), OPEN_DELAY)
  })

  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return
    const from = elementOf(event)
    if (from && (card.contains(from) || from.closest('[data-preview]'))) schedule(close, CLOSE_DELAY)
  })

  /**
   * One line, three fixes: the card closes before a click navigates; it does
   * not come back orphaned on a bfcache restore; and it cannot sit stranded
   * under the graph dialog's backdrop, where `showModal()` makes the document
   * inert and `pointerout` may never fire. The two scripts stay unaware of each
   * other: `local-graph.ts` is explicit that nothing there may be imported.
   */
  document.addEventListener('pointerdown', close)

  /**
   * `popover=auto` light-dismisses on `pointerdown` while the pointer is still
   * over the link, so no fresh `pointerover` follows and without this the card
   * would be dead until you left and re-entered.
   */
  card.addEventListener('toggle', (event) => {
    if ((event as ToggleEvent).newState === 'closed') reset()
  })
}
