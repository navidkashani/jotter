/**
 * OKLCH -> sRGB and WCAG contrast, so the build can assert the palette rather
 * than trusting that it looked fine on one screen.
 *
 * Every colour in jotter is authored in OKLCH in `src/styles/tokens.css`. That
 * is good for designing a palette and useless for checking it: WCAG contrast is
 * defined on sRGB relative luminance, so the values have to be converted back.
 */

/** Parse `oklch(52% 0.13 250)` / `oklch(52% 0.13 250 / 0.5)`. Returns null otherwise. */
export function parseOklch(value) {
  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/i.exec(
    value.trim(),
  )
  if (!match) return null
  return {
    l: Number(match[1]) / 100,
    c: Number(match[2]),
    h: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  }
}

const clamp01 = (n) => Math.min(1, Math.max(0, n))

/** OKLCH -> sRGB, each channel 0..1, gamut-clipped. */
export function oklchToSrgb({ l, c, h }) {
  const hRad = (h * Math.PI) / 180
  const a = c * Math.cos(hRad)
  const b = c * Math.sin(hRad)

  // OKLab -> LMS
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b

  const lC = l_ * l_ * l_
  const mC = m_ * m_ * m_
  const sC = s_ * s_ * s_

  // LMS -> linear sRGB
  const lr = +4.0767416621 * lC - 3.3077115913 * mC + 0.2309699292 * sC
  const lg = -1.2684380046 * lC + 2.6097574011 * mC - 0.3413193965 * sC
  const lb = -0.0041960863 * lC - 0.7034186147 * mC + 1.707614701 * sC

  const gamma = (x) => {
    const v = clamp01(x)
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  }
  return [gamma(lr), gamma(lg), gamma(lb)]
}

/** WCAG 2.x relative luminance from sRGB channels 0..1. */
export function relativeLuminance([r, g, b]) {
  const lin = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

/** Contrast between two OKLCH strings; throws when either is unparseable. */
export function contrastOklch(foreground, background) {
  const fg = parseOklch(foreground)
  const bg = parseOklch(background)
  if (!fg || !bg) throw new Error(`Not an OKLCH colour: ${!fg ? foreground : background}`)
  return contrastRatio(oklchToSrgb(fg), oklchToSrgb(bg))
}

/**
 * Read the custom properties out of a `:root`-style block.
 * Deliberately simple: tokens.css is ours, flat, and one declaration per line.
 */
export function readTokens(css, selector) {
  const start = css.indexOf(selector)
  if (start === -1) return {}
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  if (open === -1 || close === -1) return {}

  const tokens = {}
  for (const line of css.slice(open + 1, close).split('\n')) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line)
    if (match) tokens[match[1]] = match[2].trim()
  }
  return tokens
}
