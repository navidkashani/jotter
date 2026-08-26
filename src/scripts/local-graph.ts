/**
 * The local graph, drawn.
 *
 * `src/lib/` is build-time code — it imports `node:fs`. This directory is the
 * other side of that boundary: everything here runs in a browser, and nothing
 * here may be imported by a page.
 *
 * A force layout on a 2D canvas. `d3-force` does the physics and the rest is
 * hand-written, including pan, zoom and drag. That last part is not taste:
 * `d3-zoom` pulls in selection, transition, interpolate, ease and color, and
 * takes the shipped bundle from 17 KB to 78 KB — three times the whole theme's
 * budget — for behaviour that is sixty lines here.
 *
 * Sizing follows Quartz, which is tuned for exactly this box: radius
 * `2 + sqrt(links)`, no node cap.
 *
 * So does the labelling, and that is worth being precise about, because
 * "labels always drawn" is the natural thing to assume and it is not what
 * Quartz does. Its labels are drawn at a constant screen size — `label.scale
 * .set(1 / scale)` — and their opacity is `max((k - 1) / 3.75, 0)`, which at
 * its own starting zoom is *zero*. Quartz's local graph shows no labels at
 * rest; the hovered node's label is tweened to `alpha: 1`, and the rest fade
 * in only as you zoom past 1x.
 *
 * That is not a quirk, it is the only thing that works at this size. Six notes
 * with titles like "Progressive summarisation" cannot all be named inside
 * 218px: drawn at once they overlap into noise, and shrinking the type until
 * they fit stops it being type. So: dots and edges at rest, the note you are
 * on always named, the node you point at and its neighbours named, and
 * everything named once you zoom in. The list underneath names all of them,
 * always, for anyone who would rather read than point.
 *
 * Colours are read from the computed style rather than written here, so the
 * canvas obeys `tokens.css` like everything else and the build's "no colour
 * literal outside tokens.css" assertion keeps meaning something.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

/** What `LocalGraph.astro` puts in `data-graph`. */
interface Payload {
  current: string
  nodes: { slug: string; title: string; href: string }[]
  links: { source: string; target: string }[]
}

interface Node extends SimulationNodeDatum {
  slug: string
  title: string
  href: string
  /** Number of links touching this node, which is what sizes it. */
  degree: number
  /** Direct neighbours, for the hover highlight. */
  near: Set<string>
}

type Link = SimulationLinkDatum<Node>

/** Quartz's local-graph defaults, which are tuned for a box about this size. */
const REPEL = 0.5
const CENTRE = 0.3
const LINK_DISTANCE = 30

/** How far back everything unrelated to the hovered node falls. */
const DIM = 0.2
/** Gap between a node and its label, and padding around the fitted layout. */
const LABEL_GAP = 3
const PAD = 6
/** A press that travels less than this is a click, not a drag. */
const CLICK_SLOP = 4
/** Below this the dots stop reading as a graph, so let it overflow instead. */
const MIN_ZOOM = 0.35
/** And above this they stop being dots. A sparse graph may fill its card; it
 *  may not become five fat circles — see `MAX_DOT`. */
const MAX_FIT = 2.5
/** A dot's ceiling in screen pixels. Capping this rather than the zoom is what
 *  lets a sparse graph spread into a wide card without going blobby. */
const MAX_DOT = 7
/** Zoom this far in past the resting view and every label is drawn. Quartz
 *  uses 3.75, which never quite reaches full opacity inside its own zoom
 *  range; this one does. */
const LABEL_FADE = 1.5
/** The halo stroked around a label, in screen pixels. */
const HALO = 3
/** How far the reader may zoom by hand, either side of the fitted view. */
const ZOOM_RANGE = [0.2, 4] as const

function mountGraph(mount: HTMLElement) {
  let data: Payload
  try {
    data = JSON.parse(mount.dataset.graph ?? '')
  } catch {
    return // Leave the list visible; a broken payload is not worth an empty box.
  }
  if (!data.nodes || data.nodes.length < 2) return

  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  /* ---------------------------------------------------------- the graph */

  const bySlug = new Map<string, Node>()
  const nodes: Node[] = data.nodes.map((n) => {
    const node: Node = { ...n, degree: 0, near: new Set() }
    bySlug.set(n.slug, node)
    return node
  })

  const links: Link[] = []
  for (const { source, target } of data.links) {
    const a = bySlug.get(source)
    const b = bySlug.get(target)
    if (!a || !b) continue
    a.degree++
    b.degree++
    a.near.add(b.slug)
    b.near.add(a.slug)
    links.push({ source: a, target: b })
  }

  /** Quartz's sizing, in layout units. The focused note takes a little more. */
  const radius = (n: Node) => 2 + Math.sqrt(n.degree) + (n.slug === data.current ? 2 : 0)

  /* --------------------------------------------------------- the palette */

  const paint = { node: '', focus: '', edge: '', label: '', halo: '', font: '', size: 10 }
  let labelWidths = new Map<string, number>()

  const readTheme = () => {
    const root = getComputedStyle(document.documentElement)
    const token = (name: string) => root.getPropertyValue(name).trim()
    paint.node = token('--ink-faint')
    paint.focus = token('--accent')
    paint.edge = token('--rule-strong')
    paint.label = token('--ink-muted')
    // The card behind the labels, painted back around them where they collide.
    paint.halo = token('--surface')

    /**
     * The type has to come off an element that *uses* it. `--font-code` is a
     * chain of `var()`s and `getPropertyValue` hands the chain back unresolved;
     * a computed `font-family` is the resolved stack.
     */
    const own = getComputedStyle(mount)
    paint.size = parseFloat(own.fontSize) || 10
    paint.font = `${paint.size}px ${own.fontFamily}`

    ctx.font = paint.font
    labelWidths = new Map(nodes.map((n) => [n.slug, ctx.measureText(n.title).width]))
  }

  /* ------------------------------------------------------- the transform */

  let width = 0
  let height = 0
  let dpr = 1
  let zoom = 1
  /** What `fit()` last chose — the view the reader starts from. */
  let restZoom = 1
  let panX = 0
  let panY = 0
  /** Once the reader has taken hold of the view, stop refitting under them. */
  let steered = false

  /**
   * Where the dots land on screen at a given zoom. Labels are deliberately not
   * part of this: fitting to them shrinks the layout into a knot in the middle
   * of the card to make room for text that is mostly not drawn. A label near
   * an edge is nudged back inside when it is drawn instead.
   */
  const extent = (z: number) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const n of nodes) {
      const x = (n.x ?? 0) * z
      const y = (n.y ?? 0) * z
      const r = Math.min(radius(n) * z, MAX_DOT)
      minX = Math.min(minX, x - r)
      maxX = Math.max(maxX, x + r)
      minY = Math.min(minY, y - r)
      // Room under the lowest dot for a label, which never scales.
      maxY = Math.max(maxY, y + r + LABEL_GAP + paint.size)
    }

    return { minX, maxX, minY, maxY }
  }

  /**
   * Frame the whole drawing in the box we have.
   *
   * This cannot be a division, because the two things being fitted scale
   * differently: the dots shrink with the zoom and the label allowance under
   * the lowest of them never does. The extent is still monotonic in zoom
   * though, so eighteen halvings find the largest that fits — well past pixel
   * precision on a 218px card, and a few hundred operations a tick here.
   */
  const fit = () => {
    if (!width || !height) return
    const room = { w: width - PAD * 2, h: height - PAD * 2 }

    let low = MIN_ZOOM
    let high = MAX_FIT
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2
      const box = extent(mid)
      if (box.maxX - box.minX <= room.w && box.maxY - box.minY <= room.h) low = mid
      else high = mid
    }

    zoom = low
    restZoom = low
    const box = extent(zoom)
    panX = -(box.minX + box.maxX) / 2
    panY = -(box.minY + box.maxY) / 2
  }

  /* ---------------------------------------------------------- the canvas */

  let hovered: Node | null = null

  /** A node's position on screen. */
  const screenX = (n: Node) => (n.x ?? 0) * zoom + width / 2 + panX
  const screenY = (n: Node) => (n.y ?? 0) * zoom + height / 2 + panY

  /**
   * A node's drawn radius, in screen pixels: the layout radius scaled, hover
   * included, and capped. The cap is what lets `fit()` magnify a sparse graph
   * to fill a wide card without the dots turning into blobs.
   */
  const drawnRadius = (n: Node) =>
    Math.min(radius(n) * zoom, MAX_DOT) * (n === hovered ? 1.1 : 1)

  /** Is this node the hovered one, or one of its neighbours? */
  const isNear = (n: Node) => !hovered || n === hovered || hovered.near.has(n.slug)

  /**
   * Everything is drawn in screen coordinates, positions projected by hand.
   * Scaling the canvas instead would take the type and the hairlines with it,
   * and both have to hold their size: ten-pixel labels that shrink with the
   * layout stop being type at all in a 218px rail.
   */
  const draw = () => {
    if (!width || !height) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.lineWidth = 1

    for (const link of links) {
      const a = link.source as Node
      const b = link.target as Node
      const touching = !hovered || a === hovered || b === hovered
      ctx.globalAlpha = touching ? 1 : DIM
      ctx.strokeStyle = hovered && touching ? paint.focus : paint.edge
      ctx.beginPath()
      ctx.moveTo(screenX(a), screenY(a))
      ctx.lineTo(screenX(b), screenY(b))
      ctx.stroke()
    }

    for (const n of nodes) {
      ctx.globalAlpha = isNear(n) ? 1 : DIM
      ctx.fillStyle = n.slug === data.current || n === hovered ? paint.focus : paint.node
      ctx.beginPath()
      ctx.arc(screenX(n), screenY(n), drawnRadius(n), 0, Math.PI * 2)
      ctx.fill()
    }

    /**
     * Which labels are drawn is the zoom's decision, following Quartz — none
     * at rest, all of them once you have zoomed in far enough for the room to
     * exist. The note you are on and whatever you are pointing at are exempt,
     * because those are the two the reader asked for.
     *
     * Where they are drawn they are stroked in the card colour first. That is
     * the cartographer's halo, and it is the difference between overlapping
     * labels being unreadable and merely overlapping. The hovered node draws
     * last, over the top of whatever it lands on.
     */
    ctx.font = paint.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineWidth = HALO
    ctx.lineJoin = 'round'

    // Measured from the resting view, not from 1: the fit magnifies a sparse
    // graph to fill its card, and that is not the reader zooming in.
    const zoomed = Math.max(0, Math.min(1, (zoom / restZoom - 1) / LABEL_FADE))
    const ordered = hovered ? [...nodes.filter((n) => n !== hovered), hovered] : nodes

    for (const n of ordered) {
      const named = n.slug === data.current || (hovered !== null && isNear(n))
      const alpha = named ? 1 : zoomed * (isNear(n) ? 1 : DIM)
      if (alpha < 0.02) continue

      const x = screenX(n)
      const y = screenY(n) + drawnRadius(n) + LABEL_GAP
      // A dot panned out of the box takes its name with it. Pinning the label
      // to the edge instead would point at a node that is not there.
      if (x < 0 || x > width || y < 0 || y > height) continue

      // Half the label, plus the halo that is stroked around it.
      const half = (labelWidths.get(n.slug) ?? 0) / 2 + HALO
      // Nudge a label at the edge back inside rather than letting it clip.
      const inside =
        half * 2 > width - PAD * 2
          ? width / 2
          : Math.min(Math.max(x, half + PAD), width - half - PAD)

      ctx.globalAlpha = alpha
      ctx.strokeStyle = paint.halo
      ctx.strokeText(n.title, inside, y)
      ctx.fillStyle = n.slug === data.current || n === hovered ? paint.focus : paint.label
      ctx.fillText(n.title, inside, y)
    }

    ctx.globalAlpha = 1
  }

  const resize = () => {
    dpr = window.devicePixelRatio || 1
    width = mount.clientWidth
    height = mount.clientHeight
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    if (!steered) fit()
    draw()
  }

  /* ------------------------------------------------------ the simulation */

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

  const simulation = forceSimulation<Node>(nodes)
    .force('charge', forceManyBody<Node>().strength(-100 * REPEL))
    .force('centre', forceCenter<Node>(0, 0).strength(CENTRE))
    .force(
      'link',
      forceLink<Node, Link>(links)
        .id((n) => n.slug)
        .distance(LINK_DISTANCE),
    )
    .force('collide', forceCollide<Node>(radius).iterations(3))
    .on('tick', () => {
      if (!steered) fit()
      draw()
    })
    .stop()

  const start = () => {
    resize()
    if (!reduced.matches) {
      simulation.restart()
      return
    }
    /**
     * d3's documented static layout. `tick()` dispatches no events, so nothing
     * paints until we say so, and 300 is the natural count —
     * `ceil(log(alphaMin) / log(1 - alphaDecay))` — after which the simulation
     * would have stopped on its own. A live force simulation is precisely the
     * motion this setting exists to suppress.
     */
    simulation.tick(300)
    fit()
    draw()
  }

  /* ------------------------------------------------------- interaction */

  let dragging: Node | null = null
  let panning = false
  let from = { x: 0, y: 0 }
  let travelled = 0

  /** A client point, in layout coordinates. */
  const at = (event: { clientX: number; clientY: number }) => {
    const box = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - box.left - width / 2 - panX) / zoom,
      y: (event.clientY - box.top - height / 2 - panY) / zoom,
    }
  }

  /**
   * Nearest node under a client point, or null. Screen space, against the
   * radius actually drawn — no DOM per node and no hit regions.
   */
  const nodeAt = (event: { clientX: number; clientY: number }) => {
    const box = canvas.getBoundingClientRect()
    const px = event.clientX - box.left
    const py = event.clientY - box.top

    let best: Node | null = null
    let nearest = Infinity
    for (const n of nodes) {
      const distance = Math.hypot(screenX(n) - px, screenY(n) - py)
      // A little slack, so a 4px dot is not a 4px target.
      if (distance < drawnRadius(n) + 4 && distance < nearest) {
        best = n
        nearest = distance
      }
    }
    return best
  }

  canvas.addEventListener('pointerdown', (event) => {
    const held = nodeAt(event)
    from = { x: event.clientX, y: event.clientY }
    travelled = 0
    steered = true

    if (held) {
      dragging = held
      held.fx = held.x
      held.fy = held.y
      if (!reduced.matches) simulation.alphaTarget(0.3).restart()
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }

    /**
     * Touch keeps its default on empty space. Stealing a drag there to pan a
     * 218px picture would cost the reader the ability to scroll the page with
     * their thumb over the rail, which is not a trade worth making.
     */
    if (event.pointerType !== 'touch') {
      panning = true
      canvas.style.cursor = 'grabbing'
      canvas.setPointerCapture(event.pointerId)
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    travelled = Math.max(travelled, Math.hypot(event.clientX - from.x, event.clientY - from.y))

    if (dragging) {
      const p = at(event)
      dragging.fx = p.x
      dragging.fy = p.y
      // With motion suppressed the simulation is stopped, so move the node
      // itself: direct manipulation is the reader's own doing, not animation.
      if (reduced.matches) {
        dragging.x = p.x
        dragging.y = p.y
        draw()
      }
      return
    }

    if (panning) {
      panX += event.clientX - from.x
      panY += event.clientY - from.y
      from = { x: event.clientX, y: event.clientY }
      draw()
      return
    }

    const found = nodeAt(event)
    if (found === hovered) return
    hovered = found
    canvas.style.cursor = found ? 'pointer' : 'grab'
    draw()
  })

  const release = (event: PointerEvent) => {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    panning = false
    canvas.style.cursor = hovered ? 'pointer' : 'grab'
    if (!dragging) return

    const node = dragging
    dragging = null
    node.fx = null
    node.fy = null
    if (!reduced.matches) simulation.alphaTarget(0)
    // A press that did not travel is a click on the note.
    if (travelled < CLICK_SLOP) window.location.href = node.href
  }

  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)

  canvas.addEventListener('pointerleave', () => {
    if (!hovered) return
    hovered = null
    draw()
  })

  /**
   * Zoom on pinch, or Ctrl/Cmd and the wheel — the convention every embedded
   * map uses. A bare wheel is left alone deliberately: this is a small card in
   * a sticky rail, and a reader scrolling the article with the pointer over it
   * should not have the page stop under them. A trackpad pinch arrives here as
   * a wheel event with `ctrlKey` set, so it works with no extra code.
   */
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      steered = true

      const box = canvas.getBoundingClientRect()
      const sx = event.clientX - box.left - width / 2
      const sy = event.clientY - box.top - height / 2
      const anchor = { x: (sx - panX) / zoom, y: (sy - panY) / zoom }

      zoom = Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], zoom * Math.exp(-event.deltaY * 0.002)))
      // Keep whatever was under the pointer under the pointer.
      panX = sx - anchor.x * zoom
      panY = sy - anchor.y * zoom
      draw()
    },
    { passive: false },
  )

  /** The way back, for a reader who has panned or zoomed somewhere odd. */
  canvas.addEventListener('dblclick', (event) => {
    event.preventDefault()
    steered = false
    fit()
    draw()
  })

  /* ------------------------------------------------------------- wiring */

  const repaint = () => {
    readTheme()
    draw()
  }

  /**
   * `ThemeToggle` sets `documentElement.dataset.theme` rather than dispatching
   * an event of its own, so watching the attribute needs no change there. The
   * media query covers a reader who has expressed no preference and whose
   * system flips underneath them.
   */
  new MutationObserver(repaint).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint)
  new ResizeObserver(resize).observe(mount)

  readTheme()
  mount.append(canvas)

  /**
   * The list stays in the accessibility tree; only its pixels go. `display:
   * none` here would leave a screen reader with an `aria-hidden` canvas and
   * nothing else.
   */
  mount.parentElement?.querySelector('.graph-list')?.classList.add('visually-hidden')

  // Nothing runs until the rail is actually on screen, and once it settles at
  // `alphaMin` the simulation stops rather than spinning behind the article.
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      start()
    },
    { rootMargin: '128px' },
  )
  observer.observe(mount)
}

for (const mount of document.querySelectorAll<HTMLElement>('.graph-canvas[data-graph]')) {
  mountGraph(mount)
}
