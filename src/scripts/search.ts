/**
 * Search: the modal.
 *
 * The browser side of the boundary, like `local-graph.ts` and
 * `hover-preview.ts`. The one import from `src/lib/` is deliberate and narrow:
 * `src/lib/search.ts` imports nothing at all and touches no global, which is
 * what lets every decision in it be unit-tested without a DOM. Nothing else
 * here may reach across.
 *
 * As much as possible lives over there, and the split is on purpose: this file
 * has no test harness: `vitest` runs on `environment: 'node'` and there is no
 * jsdom, so anything left here is verified by hand or not at all. What stays
 * is element creation, event wiring and the async flow. What leaves is every
 * question with a right answer: which URL a result points at, which sections
 * survive, where an arrow key goes, whether a keystroke belongs to a field.
 *
 * **This script builds its own chrome, including the trigger button.** Nothing
 * renders it server-side, for the reason `local-graph.ts` already gives for its
 * expand button: a search box that does nothing with scripting off is worse
 * than no search box. With scripting off there is no button, no dialog, and the
 * header is exactly what it was before the feature existed.
 *
 * **Pagefind is loaded lazily and fails to nothing.** The runtime arrives on
 * first open, the index warms while the reader is still typing, and a rejected
 * import (no index built yet, `astro dev` on a fresh checkout) shows a quiet
 * message instead of throwing.
 */
import {
  excerptParts,
  headingJumps,
  isTypingTarget,
  nextStop,
  normalizeResultUrl,
} from '../lib/search.js'

/**
 * Pagefind's browser API, narrowed to what is used here.
 *
 * Hand-written rather than imported: the module is fetched from `/pagefind/` at
 * runtime and does not exist in `node_modules` at build time, so there is
 * nothing for TypeScript to read. Every field below was checked against the
 * bundle Pagefind 1.5.2 emits.
 */
interface PagefindApi {
  init(): Promise<void>
  preload(term: string): Promise<void>
  /** Resolves `null` when a newer search has superseded this one. */
  debouncedSearch(
    term: string,
    options: Record<string, unknown>,
    debounceMs: number,
  ): Promise<{ results: PagefindResult[] } | null>
}

interface PagefindResult {
  data(): Promise<PagefindData>
}

interface PagefindData {
  url: string
  /** Escaped HTML containing `<mark>`. Never assign it as HTML. */
  excerpt: string
  plain_excerpt?: string
  meta?: Record<string, string>
  sub_results?: { title: string; url: string; excerpt: string; plain_excerpt?: string }[]
}

/** What `Search.astro` puts in `data-search`. */
interface Labels {
  search: string
  placeholder: string
  results: string
  noResults: string
  close: string
  unavailable: string
}

/**
 * Typed as `string`, not left to infer its literal type: TypeScript resolves a
 * literal specifier in `import()` and this module does not exist until a build
 * has written it. Vite is told to leave it alone at the call site.
 */
const RUNTIME: string = '/pagefind/pagefind.js'

/** Pagefind's own default, and a reasonable one: long enough to be a word. */
const DEBOUNCE = 300

/** Past this the list is a wall rather than an answer. */
const MAX_RESULTS = 12
const MAX_SUB_RESULTS = 3

const strings = document.querySelector<HTMLElement>('[data-search]')?.dataset.search
if (strings) setup(JSON.parse(strings) as Labels)

function setup(labels: Labels) {
  /* ------------------------------------------------------------- chrome */

  const icon = (paths: string[]) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '15')
    svg.setAttribute('height', '15')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.4')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    for (const path of paths) {
      const d = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      d.setAttribute('d', path)
      svg.append(d)
    }
    return svg
  }

  const MAGNIFIER = ['M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z', 'm11 11 3.5 3.5']

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'icon-button search-trigger'
  trigger.setAttribute('aria-label', labels.search)
  trigger.title = labels.search
  trigger.append(icon(MAGNIFIER))

  const dialog = document.createElement('dialog')
  dialog.className = 'search-dialog'
  dialog.setAttribute('aria-label', labels.search)

  const head = document.createElement('div')
  head.className = 'search-head'

  const input = document.createElement('input')
  /**
   * `type="text"` with `role="searchbox"`, and **not** `type="search"`.
   *
   * A native search field handles Escape itself: the first press clears the
   * value and stops there, so closing the dialog took two presses and the first
   * one silently ate the query. Measured, not assumed: Chrome reports the
   * field empty and the dialog still open after one Escape.
   *
   * What `type="search"` bought was a clear button. What it cost was Esc, which
   * is the way out of a modal and the one keystroke that has to work. The role
   * keeps the semantics a screen reader announces.
   */
  input.type = 'text'
  input.setAttribute('role', 'searchbox')
  input.className = 'search-input'
  input.placeholder = labels.placeholder
  input.setAttribute('aria-label', labels.search)
  // A search field is not a name, an address or anything a browser should
  // remember or correct.
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('enterkeyhint', 'search')

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'icon-button search-close'
  dismiss.setAttribute('aria-label', labels.close)
  dismiss.title = labels.close
  dismiss.append(icon(['M13 3 3 13M3 3l10 10']))

  head.append(icon(MAGNIFIER), input, dismiss)

  /**
   * One region for both the count and every failure message, so a screen
   * reader hears one consistent answer rather than a count from one element
   * and "nothing found" from another.
   */
  const status = document.createElement('p')
  status.className = 'search-status'
  status.setAttribute('aria-live', 'polite')

  const list = document.createElement('ul')
  list.className = 'search-results'

  dialog.append(head, status, list)

  /* ------------------------------------------------------------ loading */

  /**
   * Memoized on the promise rather than on the module, so a second open during
   * a slow first load waits on the same import instead of starting another.
   * Anything that goes wrong resolves to `null`: this is the whole of "fails
   * to nothing".
   */
  let runtime: Promise<PagefindApi | null> | null = null
  let started: Promise<void> | null = null
  /** Set once the runtime has proved unusable, so it is not retried per key. */
  let broken = false

  /**
   * **A resolved import is not proof of a working runtime.**
   *
   * A 0-byte `pagefind.js` (the exact corruption `src/integrations/search.ts`
   * fails the build over) imports *successfully*, as an empty module
   * namespace. Left unchecked, `api.init` is `undefined`, the call throws
   * inside a `void`-ed promise, and the reader gets an unhandled rejection and
   * a blank modal instead of the message saying search is unavailable.
   *
   * So the shape is checked rather than assumed, and every entry point below
   * goes through here.
   */
  const usable = (module: unknown): module is PagefindApi =>
    typeof (module as PagefindApi)?.init === 'function' &&
    typeof (module as PagefindApi)?.preload === 'function' &&
    typeof (module as PagefindApi)?.debouncedSearch === 'function'

  const load = () =>
    (runtime ??= import(/* @vite-ignore */ RUNTIME).then(
      (module) => (usable(module) ? module : null),
      () => null,
    ))

  /**
   * The runtime, initialised. `null` once and for all if there is no index or
   * it cannot start: `broken` rather than a reset, so a failure costs one
   * attempt rather than one per keystroke, and a rejected `started` is never
   * awaited twice.
   */
  const ready = async () => {
    if (broken) return null
    const api = await load()
    if (!api) {
      broken = true
      return null
    }
    try {
      started ??= api.init()
      await started
      return api
    } catch {
      broken = true
      return null
    }
  }

  /* ------------------------------------------------------------ results */

  /**
   * Pagefind's excerpt is *escaped* HTML with `<mark>` in it, so neither
   * `innerHTML` (which nothing in `src/` uses) nor splitting on the tags
   * (which would render `&amp;` and `&#x27;` literally) is available.
   *
   * `DOMParser` neither executes scripts nor loads resources, so parsing is
   * the safe way to decode the entities. `excerptParts` then keeps text nodes
   * and `<mark>` and drops everything else, and each run is set with
   * `textContent`.
   */
  const renderExcerpt = (into: HTMLElement, data: { excerpt: string; plain_excerpt?: string }) => {
    const body = new DOMParser().parseFromString(data.excerpt, 'text/html').body
    const parts = excerptParts(body.childNodes)

    if (parts.length === 0) {
      into.textContent = data.plain_excerpt ?? body.textContent ?? ''
      return
    }
    for (const part of parts) {
      if (!part.mark) {
        into.append(part.text)
        continue
      }
      const mark = document.createElement('mark')
      mark.textContent = part.text
      into.append(mark)
    }
  }

  const resultLink = (href: string, title: string, className: string) => {
    const link = document.createElement('a')
    link.className = className
    link.href = href
    const name = document.createElement('span')
    name.className = 'search-result-title'
    name.textContent = title
    link.append(name)
    return link
  }

  const render = (found: PagefindData[]) => {
    list.replaceChildren()

    for (const item of found) {
      const href = normalizeResultUrl(item.url)
      const row = document.createElement('li')
      const link = resultLink(href, item.meta?.title ?? href, 'search-result')

      const excerpt = document.createElement('span')
      excerpt.className = 'search-excerpt'
      renderExcerpt(excerpt, item)
      link.append(excerpt)
      row.append(link)

      // Which sections survive, and what each links to, is decided in
      // `src/lib/search.ts` where vitest can reach it.
      const sections = headingJumps(item.sub_results, href, MAX_SUB_RESULTS)

      if (sections.length > 0) {
        const nested = document.createElement('ul')
        nested.className = 'search-sections'
        for (const section of sections) {
          const jump = document.createElement('li')
          const anchor = resultLink(section.href, section.title, 'search-section')
          const context = document.createElement('span')
          context.className = 'search-excerpt'
          renderExcerpt(context, section)
          anchor.append(context)
          jump.append(anchor)
          nested.append(jump)
        }
        row.append(nested)
      }

      list.append(row)
    }
  }

  /* ------------------------------------------------------------- search */

  /**
   * `debouncedSearch` resolves `null` for a superseded search, which covers
   * the searches themselves. The token covers what happens *after* one
   * resolves: a slow batch of `data()` calls for an older term could otherwise
   * still land on top of a newer term's results.
   */
  let sequence = 0
  /** The term the list currently shows, which lags the field while debouncing. */
  let rendered = ''

  const run = async (term: string) => {
    const token = ++sequence

    if (!term) {
      list.replaceChildren()
      status.textContent = ''
      rendered = ''
      return
    }

    const api = await ready()
    if (token !== sequence) return
    if (!api) {
      list.replaceChildren()
      status.textContent = labels.unavailable
      rendered = ''
      return
    }

    const search = await api.debouncedSearch(term, {}, DEBOUNCE)
    if (search === null || token !== sequence) return

    const found = await Promise.all(search.results.slice(0, MAX_RESULTS).map((r) => r.data()))
    if (token !== sequence) return

    render(found)
    /**
     * The *match* count, not the rendered one. `found` is capped at
     * `MAX_RESULTS`, so announcing its length would tell a reader "12 results"
     * for a query that matched eighty, and the announcement is the only way a
     * screen-reader user learns how much is there.
     */
    status.textContent = search.results.length
      ? labels.results.replace('{count}', String(search.results.length))
      : labels.noResults
    // What the list currently shows, so Enter cannot act on a stale render.
    rendered = term
  }

  input.addEventListener('input', () => {
    const term = input.value.trim()
    // Warm the index chunks for what has been typed so far while the reader is
    // still typing the rest. Cheap, and it is most of why the first search
    // feels instant rather than merely fast.
    if (term) void load().then((api) => api?.preload(term))
    void run(term)
  })

  // Deferred to first focus rather than first open: opening the dialog is a
  // keystroke, and `init()` downloads the metadata for the whole index.
  input.addEventListener('focus', () => void ready(), { once: true })

  /* ----------------------------------------------------------- keyboard */

  /** The tab order the arrows walk: the field, then every link in the list. */
  const stops = () => [input, ...list.querySelectorAll<HTMLAnchorElement>('a')]

  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const all = stops()
    const here = all.indexOf(document.activeElement as HTMLAnchorElement)
    event.preventDefault()
    all[nextStop(here, all.length, event.key === 'ArrowDown' ? 1 : -1)]?.focus()
  })

  /**
   * Enter in the field takes the first result, which is the one a reader who
   * never touched the arrows means.
   *
   * Guarded on `rendered`, because searching is debounced by 300ms: for that
   * window the list still holds the *previous* term's results, and a reader who
   * types and hits Enter quickly would otherwise be navigated to a result for
   * the term they had just replaced. Doing nothing is right: the results they
   * asked for are milliseconds away.
   */
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (input.value.trim() !== rendered) return
    list.querySelector('a')?.click()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'k' && event.key !== 'K') return
    if (!event.metaKey && !event.ctrlKey) return

    /**
     * Ignored while focus is in a field: including this dialog's own input,
     * so Cmd+K while typing does not re-trigger and wipe what was typed.
     */
    const focused = document.activeElement
    if (focused instanceof HTMLElement && isTypingTarget(focused)) return

    event.preventDefault()
    open()
  })

  /* ------------------------------------------------------- open / close */

  const open = () => {
    if (dialog.open) return
    dialog.showModal()
    input.focus()
    input.select()
  }

  trigger.addEventListener('click', open)
  dismiss.addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  /**
   * On `close` rather than on the button, so Esc, the close button and a
   * backdrop click are one path instead of three: the same argument
   * `local-graph.ts` makes for its dialog. Esc is the browser's, which is also
   * what makes search stack correctly over an open graph dialog: the topmost
   * one in the top layer closes first.
   */
  dialog.addEventListener('close', () => trigger.focus())

  document.querySelector('.header-actions')?.append(trigger)
  document.body.append(dialog)
}
