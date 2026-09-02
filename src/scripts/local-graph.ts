/**
 * The local graph, drawn.
 *
 * `src/lib/` is build-time code: it imports `node:fs`. This directory is the
 * other side of that boundary: everything here runs in a browser, and nothing
 * here may be imported by a page.
 *
 * A force layout on a 2D canvas. `d3-force` does the physics and the rest is
 * hand-written, including pan, zoom and drag. That last part is not taste:
 * `d3-zoom` pulls in selection, transition, interpolate, ease and color, and
 * takes the shipped bundle from 17 KB to 78 KB (three times the whole theme's
 * budget) for behaviour that is sixty lines here.
 *
 * Sizing follows Quartz, which is tuned for exactly this box: radius
 * `2 + sqrt(links)`, no node cap.
 *
 * The labelling does not, and that is worth being precise about, because this
 * file used to argue the opposite. Quartz hides labels at rest (their opacity
 * is `max((k - 1) / 3.75, 0)`, which at its own starting zoom is *zero*), and
 * that was taken as the rule. But the reference this theme is measured
 * against, `navidk.com/start`, is not Quartz: it is Obsidian Publish, and
 * Obsidian draws every label, always. Two products, opposite defaults, and
 * copying the wrong one left the rail card a picture with no names on it.
 *
 * So: every label, always. What makes that affordable is the same thing that
 * makes it affordable for Obsidian: the expand button, and the dialog behind
 * it. The card is a glanceable map; the dialog is where you read.
 *
 * The card is also the harder problem of the two. Obsidian gives its graph
 * 290px and still lets "Wisdom & Approaches" run into "Now"; jotter's rail is
 * 216px and its titles are longer, so "just make the type smaller" would put
 * it below every size in `tokens.css` and *still* overlap. Four things buy the
 * room back instead: the labels are set in the body sans rather than the mono
 * (about 17% narrower, and mixed-case titles read better in it anyway); they
 * are elided to a budget that scales with the box, so the rail trims and the
 * dialog never does; the halo below keeps whatever still overlaps readable;
 * and a soft separation force tiles them into rows rather than stacks. The
 * hovered node draws its full title over the top, which is what makes eliding
 * the rest safe.
 *
 * The list underneath names all of them, always, for anyone who would rather
 * read than point.
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
  /** Translated, because nothing in this file may reach `src/i18n/`. Optional
   *  only so that a page built before these keys existed still draws. */
  labels?: { expand: string; close: string }
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
/**
 * The fit's ceiling. This used to be 2.5, which was fine while the only box
 * was a 216px card that binds long before it, and wrong the moment the dialog
 * arrived, where it pinned a six-node neighbourhood into a 200px knot adrift
 * in 1100px of nothing. A magnified layout is not the failure mode here;
 * `MAX_DOT` is what stops five fat circles, and it does that regardless.
 */
const MAX_FIT = 8
/** A dot's ceiling in screen pixels. Capping this rather than the zoom is what
 *  lets a sparse graph spread into a wide card without going blobby. */
const MAX_DOT = 7
/**
 * A label's width budget, in screen pixels: `min(MAX_LABEL, width * SHARE)`.
 *
 * The share is what binds in the rail (45% of 216px is about 96px, roughly
 * sixteen characters of 10px sans), and the ceiling is what binds in the
 * dialog, where 320px is past any title anyone will write, so nothing there is
 * ever elided. Two constants rather than two code paths.
 */
const MAX_LABEL = 320
const LABEL_SHARE = 0.45
/** How hard overlapping labels shove each other apart. Soft on purpose: this
 *  is one force among five and it has to lose arguments with the others. */
const LABEL_PUSH = 0.4
/** The halo stroked around a label, in screen pixels. */
const HALO = 3
/** How far the reader may zoom by hand. The ceiling has to clear `MAX_FIT`, or
 *  the first wheel notch in the dialog would jump the view backwards to meet
 *  a clamp the fit had already passed. */
const ZOOM_RANGE = [0.2, 12] as const

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
  /** Full title widths, for the hovered label, which never elides. */
  let labelWidths = new Map<string, number>()
  /** And what everything else draws: elided to the budget, width included so
   *  the separation force and the edge nudge do not re-measure every tick. */
  let labelShort = new Map<string, { text: string; width: number }>()

  /** Trim by measured width, not by character count: proportional type makes
   *  "Illuminating" and "MMMMMMMMMMMM" different sizes of the same twelve. */
  const elide = (title: string, budget: number) => {
    if (ctx.measureText(title).width <= budget) return title
    let cut = title.length
    while (cut > 1 && ctx.measureText(`${title.slice(0, cut)}…`).width > budget) cut--
    return `${title.slice(0, cut).trimEnd()}…`
  }

  /** Rebuilt whenever the type changes or the box does, and never per frame. */
  const measure = () => {
    ctx.font = paint.font
    const budget = Math.min(MAX_LABEL, (width || 0) * LABEL_SHARE)
    labelWidths = new Map()
    labelShort = new Map()
    for (const n of nodes) {
      labelWidths.set(n.slug, ctx.measureText(n.title).width)
      const text = elide(n.title, budget)
      labelShort.set(n.slug, { text, width: ctx.measureText(text).width })
    }
  }

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
     * The type has to come off an element that *uses* it. `--font-body` is a
     * chain of `var()`s and `getPropertyValue` hands the chain back unresolved;
     * a computed `font-family` is the resolved stack. It is read from whichever
     * box currently holds the canvas, because the dialog sets a larger label
     * size than the rail does.
     */
    const own = getComputedStyle(box)
    paint.size = parseFloat(own.fontSize) || 10
    paint.font = `${paint.size}px ${own.fontFamily}`
    measure()
  }

  /* ------------------------------------------------------- the transform */

  /** Whichever element the canvas is living in: the rail card, or the dialog.
   *  Every measurement (size, type, budget) is taken from this. */
  let box: HTMLElement = mount
  let width = 0
  let height = 0
  let dpr = 1
  let zoom = 1
  let panX = 0
  let panY = 0
  /** Once the reader has taken hold of the view, stop refitting under them. */
  let steered = false

  /**
   * Where the dots land on screen at a given zoom. Only the label band under
   * the lowest dot is counted, not label *widths*: fitting to those would
   * shrink the layout into a knot in the middle of the card to reserve room
   * for text that the elision has already bounded. A label near a side edge is
   * nudged back inside when it is drawn instead.
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
   * though, so eighteen halvings find the largest that fits: well past pixel
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
    const drawn = extent(zoom)
    panX = -(drawn.minX + drawn.maxX) / 2
    panY = -(drawn.minY + drawn.maxY) / 2
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
     * Every node is named, every time (see the note at the top of this file).
     * Only the hover highlight changes what a label looks like, and it changes
     * it exactly the way it changes the dot beneath it.
     *
     * Each is stroked in the card colour first. That is the cartographer's
     * halo, and it is the difference between overlapping labels being
     * unreadable and merely overlapping. The hovered node draws last, over the
     * top of whatever it lands on, and draws its *full* title rather than the
     * elided one, which is what makes eliding all the others safe.
     */
    ctx.font = paint.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineWidth = HALO
    ctx.lineJoin = 'round'

    const ordered = hovered ? [...nodes.filter((n) => n !== hovered), hovered] : nodes

    for (const n of ordered) {
      const x = screenX(n)
      const y = screenY(n) + drawnRadius(n) + LABEL_GAP
      // A dot panned out of the box takes its name with it. Pinning the label
      // to the edge instead would point at a node that is not there.
      if (x < 0 || x > width || y < 0 || y > height) continue

      const short = labelShort.get(n.slug)
      const full = n === hovered
      const text = full ? n.title : (short?.text ?? n.title)
      // Half the label, plus the halo that is stroked around it.
      const half = (full ? (labelWidths.get(n.slug) ?? 0) : (short?.width ?? 0)) / 2 + HALO
      // Nudge a label at the edge back inside rather than letting it clip.
      const inside =
        half * 2 > width - PAD * 2
          ? width / 2
          : Math.min(Math.max(x, half + PAD), width - half - PAD)

      ctx.globalAlpha = isNear(n) ? 1 : DIM
      ctx.strokeStyle = paint.halo
      ctx.strokeText(text, inside, y)
      ctx.fillStyle = n.slug === data.current || n === hovered ? paint.focus : paint.label
      ctx.fillText(text, inside, y)
    }

    ctx.globalAlpha = 1
  }

  const resize = () => {
    const was = width
    dpr = window.devicePixelRatio || 1
    width = box.clientWidth
    height = box.clientHeight
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    // The elision budget is a fraction of the box, so a new box is new labels.
    if (width !== was) measure()
    if (!steered) fit()
    draw()
  }

  /* ------------------------------------------------------ the simulation */

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

  /**
   * Keep labels off each other's backs.
   *
   * A custom d3 force rather than a post-tick nudge, so it relaxes alongside
   * the charge and the links instead of fighting them: every push is scaled by
   * `alpha`, which means it argues loudly while the layout is still forming
   * and falls silent as the simulation cools. That is also why it cannot
   * oscillate: the thing driving it decays to zero.
   *
   * Only Y. Labels are wide and short, so two of them a few pixels apart
   * horizontally are still two rows you can read, while two a few pixels apart
   * vertically are a smudge. Pushing them into rows is the whole trick.
   *
   * Label geometry is screen-sized, so it is divided back through `zoom` into
   * the layout coordinates the simulation actually moves nodes in. `fit()`
   * recomputes `zoom` every tick, which makes this force follow the framing
   * rather than assume one. At n ≤ 20 that is at most 190 pairs a tick.
   */
  const separateLabels = (alpha: number) => {
    if (!zoom) return
    const band = paint.size / zoom
    const drop = (n: Node) => (n.y ?? 0) + radius(n) + (LABEL_GAP + paint.size / 2) / zoom
    const reach = (n: Node) => ((labelShort.get(n.slug)?.width ?? 0) / 2 + HALO) / zoom

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      const ay = drop(a)
      const ar = reach(a)
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        if (Math.abs((a.x ?? 0) - (b.x ?? 0)) >= ar + reach(b)) continue
        const dy = drop(b) - ay
        const overlap = band - Math.abs(dy)
        if (overlap <= 0) continue
        // Exactly coincident is the one case with no direction to push in, so
        // pick one; anything else would leave the pair welded together.
        const shove = ((dy < 0 ? -1 : 1) * overlap * alpha * LABEL_PUSH) / 2
        a.vy = (a.vy ?? 0) - shove
        b.vy = (b.vy ?? 0) + shove
      }
    }
  }

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
    .force('labels', separateLabels)
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
     * paints until we say so, and 300 is the natural count
     * (`ceil(log(alphaMin) / log(1 - alphaDecay))`) after which the simulation
     * would have stopped on its own. A live force simulation is precisely the
     * motion this setting exists to suppress.
     *
     * One tick at a time with a refit between, rather than `tick(300)`, so
     * that this is the same 300 ticks the animated path takes: the label
     * separation force reads `zoom`, and `tick(300)` would freeze it at
     * whatever the initial spiral happened to fit to. Reduced motion is meant
     * to suppress the animation, not to produce a different picture.
     */
    for (let i = 0; i < 300; i++) {
      simulation.tick()
      fit()
    }
    draw()
  }

  /* ------------------------------------------------------- interaction */

  let dragging: Node | null = null
  let panning = false
  let from = { x: 0, y: 0 }
  let travelled = 0

  /** A client point, in layout coordinates. */
  const at = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left - width / 2 - panX) / zoom,
      y: (event.clientY - rect.top - height / 2 - panY) / zoom,
    }
  }

  /**
   * Nearest node under a client point, or null. Screen space, against the
   * radius actually drawn: no DOM per node and no hit regions.
   */
  const nodeAt = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top

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
   * Zoom on pinch, or Ctrl/Cmd and the wheel: the convention every embedded
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

      const rect = canvas.getBoundingClientRect()
      const sx = event.clientX - rect.left - width / 2
      const sy = event.clientY - rect.top - height / 2
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

  /* ------------------------------------------------------------- expand */

  /**
   * The rail card is 216px wide, which is enough to see a shape in and not
   * enough to read one. This is the way out: Obsidian Publish's own answer,
   * and the thing that makes drawing every label at that size defensible.
   *
   * Both the button and the dialog are built here rather than sitting in
   * `LocalGraph.astro`, which keeps the no-JavaScript contract exactly as it
   * was: with scripting off there is no canvas, no button, no dialog, and the
   * mount collapses under `:empty` leaving the list as the whole feature.
   */
  const icon = (path: string) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.4')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    d.setAttribute('d', path)
    svg.append(d)
    return svg
  }

  const button = (className: string, label: string, path: string) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `icon-button ${className}`
    el.setAttribute('aria-label', label)
    el.title = label
    el.append(icon(path))
    return el
  }

  const names = data.labels ?? { expand: 'Expand', close: 'Close' }
  // Two arrows out of a shared corner, and two back into one.
  const expand = button('graph-expand', names.expand, 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9')
  const dismiss = button('graph-close', names.close, 'M13 3 3 13M3 3l10 10')

  const dialog = document.createElement('dialog')
  dialog.className = 'graph-dialog'
  const stage = document.createElement('div')
  stage.className = 'graph-stage'
  dialog.append(dismiss, stage)

  /**
   * The *same* canvas moves into the dialog rather than a second one being
   * built beside it. One canvas is one simulation, one hover state and one
   * palette, and it means the graph you expand is the graph you were just
   * looking at rather than a fresh layout of the same data.
   */
  expand.addEventListener('click', () => {
    dialog.showModal()
    stage.append(canvas)
    box = stage
    // The reader's pan and zoom belonged to a 216px card; the new box gets the
    // fit it deserves. The dialog sets its own label size, so re-read the type.
    steered = false
    readTheme()
    resize()
    // Let the layout relax into an aspect ratio it was never fitted for. Under
    // reduced motion the refit above has already framed it, and that is enough.
    if (!reduced.matches) simulation.alpha(0.3).restart()
  })

  dismiss.addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  // Listening on `close` rather than on the button is what makes Esc, the
  // close button and a backdrop click all one path instead of three.
  dialog.addEventListener('close', () => {
    mount.append(canvas)
    box = mount
    steered = false
    readTheme()
    resize()
    expand.focus()
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
  // Both boxes, because either one may be the live one. `resize()` reads
  // whichever currently holds the canvas, so the idle observer is a no-op.
  const watcher = new ResizeObserver(resize)
  watcher.observe(mount)
  watcher.observe(stage)

  document.body.append(dialog)
  mount.append(expand, canvas)
  readTheme()

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
