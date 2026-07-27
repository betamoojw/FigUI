/** Lightweight G-code parser – extracts toolpath segments for 2D visualisation. */

export interface Segment {
  x0: number; y0: number; z0: number
  x1: number; y1: number; z1: number
  /** One-based physical row in the source G-code file. */
  sourceLine: number
  /**
   * G0 move = 'rapid'
   * G1/G2/G3 while spindle is on (or no spindle machine) = 'feed'
   * G1/G2/G3 while spindle is off on a spindle machine = 'traverse'
   */
  moveType: 'rapid' | 'feed' | 'traverse'
  feedMmPerMin?: number
  /** G93 inverse-time duration for this move, before the feed override. */
  inverseTimeSeconds?: number
  /** Motion has no determinable feed rate (for example G95 without RPM). */
  timingUnknown?: boolean
  tool?: number
  /** For arcs: center offsets (relative to start). undefined for lines. */
  i?: number; j?: number; k?: number
  /** Active plane for an arc; omitted for the usual G17 XY plane. */
  arcPlane?: 17 | 18 | 19
  /** true = clockwise arc (G2) */
  cw?: boolean
}

export interface GCodeTool {
  number: number
  label: string
  sourceLine: number
}

export interface GCodeModel {
  segments: Segment[]
  tools?: GCodeTool[]
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  totalLines: number
  /** Fixed controller waits that can be included in a runtime estimate. */
  fixedDelays?: Array<[sourceLine: number, seconds: number]>
  /** Spindle state changes; their configured controller delays are timed later. */
  spindleTransitions?: Array<[sourceLine: number, state: 'on' | 'off']>
  /** First M2/M30 source line; program content after it will not execute. */
  timingEndLine?: number
}

export type WorkCoordinateSystem = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59' | 'G59.1' | 'G59.2' | 'G59.3'

export interface WorkOffset {
  x: number
  y: number
  z: number
}

export interface ParseGCodeOptions {
  activeWcs?: WorkCoordinateSystem
  currentWco?: WorkOffset
  workOffsets?: Partial<Record<WorkCoordinateSystem, WorkOffset>>
}

/** Map segment index → approximate source-line fraction (0..1) */
export function segmentProgress(idx: number, total: number): number {
  return total > 0 ? idx / total : 0
}

const WORK_COORDINATE_SYSTEMS = new Set<WorkCoordinateSystem>([
  'G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3',
])

function normalizeWcs(code: string | undefined): WorkCoordinateSystem | undefined {
  if (!code) return undefined
  const upper = code.toUpperCase()
  return WORK_COORDINATE_SYSTEMS.has(upper as WorkCoordinateSystem)
    ? upper as WorkCoordinateSystem
    : undefined
}

function wcsFromGValue(g: number): WorkCoordinateSystem | null {
  if (g === 54) return 'G54'
  if (g === 55) return 'G55'
  if (g === 56) return 'G56'
  if (g === 57) return 'G57'
  if (g === 58) return 'G58'
  if (g === 59) return 'G59'
  if (g === 59.1) return 'G59.1'
  if (g === 59.2) return 'G59.2'
  if (g === 59.3) return 'G59.3'
  return null
}

function getShift(
  wcs: WorkCoordinateSystem | undefined,
  activeWcs: WorkCoordinateSystem | undefined,
  currentWco: WorkOffset,
  workOffsets: Partial<Record<WorkCoordinateSystem, WorkOffset>>,
): WorkOffset {
  if (!wcs || wcs === activeWcs) return { x: 0, y: 0, z: 0 }
  const target = workOffsets[wcs]
  if (!target) return { x: 0, y: 0, z: 0 }
  return {
    x: target.x - currentWco.x,
    y: target.y - currentWco.y,
    z: target.z - currentWco.z,
  }
}

function stripComments(raw: string) {
  const comments: string[] = []
  const withoutParens = raw.replace(/\(([^)]*)\)/g, (_match, comment) => {
    comments.push(String(comment).trim())
    return ' '
  })
  const semicolon = withoutParens.indexOf(';')
  if (semicolon >= 0) {
    comments.push(withoutParens.slice(semicolon + 1).trim())
    return { code: withoutParens.slice(0, semicolon), comments }
  }
  return { code: withoutParens, comments }
}

function cleanToolName(value: string | undefined) {
  const cleaned = (value ?? '')
    .replace(/\b[GMTXYZIJKRFSPH]\s*-?(?:\d+\.?\d*|\.\d+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

function toolLabel(tool: number, name: string | null) {
  return name ? `T${tool} ${name}` : `T${tool}`
}

export function parseGCode(text: string, options: ParseGCodeOptions = {}): GCodeModel {
  const segments: Segment[] = []
  let x = 0, y = 0, z = 0
  let offX = 0, offY = 0, offZ = 0        // G92 coordinate offsets
  let activeWcs = normalizeWcs(options.activeWcs) ?? 'G54'
  const currentWco = options.currentWco ?? { x: 0, y: 0, z: 0 }
  const workOffsets = options.workOffsets ?? {}
  let wcsShift = getShift(activeWcs, activeWcs, currentWco, workOffsets)
  let rapid = true
  let arcMode: 0 | 2 | 3 = 0   // 0 = linear, 2 = CW arc, 3 = CCW arc
  let plane = 17               // G17=XY, G18=ZX, G19=YZ
  let incremental = false
  let inchMode = false         // G20=inches, G21=mm
  let spindleOn = false        // Track spindle state
  let spindleEverOn = false    // Whether spindle was ever activated (false = no spindle machine e.g. pen plotter)
  let feedMmPerMin = 0
  let feedMmPerRev = 0
  let spindleRpm: number | null = null
  let feedRateMode: 93 | 94 | 95 = 94
  let pendingTool: number | null = null
  let activeTool: number | null = null
  let sawToolChange = false
  const tools = new Map<number, GCodeTool>()
  const fixedDelays: Array<[number, number]> = []
  const spindleTransitions: Array<[number, 'on' | 'off']> = []
  let timingEndLine: number | undefined
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }

  function getMoveType(): 'rapid' | 'feed' | 'traverse' {
    if (rapid) return 'rapid'
    if (spindleEverOn && !spindleOn) return 'traverse'
    return 'feed'
  }

  function expandBounds(px: number, py: number, pz: number) {
    if (px < bounds.minX) bounds.minX = px
    if (px > bounds.maxX) bounds.maxX = px
    if (py < bounds.minY) bounds.minY = py
    if (py > bounds.maxY) bounds.maxY = py
    if (pz < bounds.minZ) bounds.minZ = pz
    if (pz > bounds.maxZ) bounds.maxZ = pz
  }

  const lines = text.split('\n')
  for (let sourceIndex = 0; sourceIndex < lines.length; sourceIndex++) {
    const raw = lines[sourceIndex]
    const sourceLine = sourceIndex + 1
    const stripped = stripComments(raw)
    const line = stripped.code.trim().toUpperCase()
    if (!line) continue

    // Parse words
    const words: Record<string, number> = {}
    let gCodes: number[] = []
    let mCodes: number[] = []
    const re = /([A-Z])(-?(?:\d+\.?\d*|\.\d+))/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const letter = m[1]
      const val = parseFloat(m[2])
      if (letter === 'G') {
        gCodes.push(val)
      } else if (letter === 'M') {
        mCodes.push(val)
      } else {
        words[letter] = val
      }
    }

    if (Number.isFinite(words.T)) {
      pendingTool = Math.trunc(words.T)
      if (!sawToolChange) {
        activeTool = pendingTool
        if (!tools.has(activeTool)) {
          tools.set(activeTool, { number: activeTool, label: toolLabel(activeTool, cleanToolName(stripped.comments[0])), sourceLine })
        }
      }
    }

    // Process M codes (spindle control)
    for (const mc of mCodes) {
      if (mc === 3 || mc === 4) {
        if (!spindleOn) spindleTransitions.push([sourceLine, 'on'])
        spindleOn = true; spindleEverOn = true
      }  // M3/M4 = spindle on
      else if (mc === 5) {
        if (spindleOn) spindleTransitions.push([sourceLine, 'off'])
        spindleOn = false
      }        // M5 = spindle off
      else if (mc === 6 && pendingTool != null) {
        activeTool = pendingTool
        sawToolChange = true
        const name = cleanToolName(stripped.comments[0]) ?? cleanToolName(stripped.code)
        const existing = tools.get(activeTool)
        if (!existing || existing.label === `T${activeTool}`) {
          tools.set(activeTool, { number: activeTool, label: toolLabel(activeTool, name), sourceLine })
        }
      }
    }

    // Process G codes
    for (const g of gCodes) {
      if (g === 90) { incremental = false; continue }
      if (g === 91) { incremental = true; continue }
      if (g === 20) { inchMode = true; continue }
      if (g === 21) { inchMode = false; continue }
      if (g === 93 || g === 94 || g === 95) {
        feedRateMode = g
        continue
      }
      if (g === 17 || g === 18 || g === 19) { plane = g; continue }
      const nextWcs = wcsFromGValue(g)
      if (nextWcs) {
        activeWcs = nextWcs
        wcsShift = getShift(activeWcs, normalizeWcs(options.activeWcs), currentWco, workOffsets)
        continue
      }
      if (g === 0) { rapid = true; arcMode = 0 }
      else if (g === 1) { rapid = false; arcMode = 0 }
      else if (g === 2) { rapid = false; arcMode = 2 }
      else if (g === 3) { rapid = false; arcMode = 3 }
    }

    if (inchMode) {
      for (const key of ['X', 'Y', 'Z', 'I', 'J', 'K', 'R'] as const) {
        if (key in words) words[key] *= 25.4
      }
      if (feedRateMode !== 93 && Number.isFinite(words.F)) words.F *= 25.4
    }

    if (Number.isFinite(words.F) && words.F > 0) {
      if (feedRateMode === 95) feedMmPerRev = words.F
      else if (feedRateMode !== 93) feedMmPerMin = words.F
    }
    if (Number.isFinite(words.S) && words.S >= 0) spindleRpm = words.S

    if (gCodes.includes(4)) {
      if (Number.isFinite(words.P) && words.P >= 0) {
        fixedDelays.push([sourceLine, words.P])
      }
    }

    if (mCodes.some(code => code === 2 || code === 30) && timingEndLine == null) {
      timingEndLine = sourceLine
    }

    // G92 – set coordinate offset
    if (gCodes.includes(92)) {
      offX = x - wcsShift.x - (words.X ?? (x - wcsShift.x))
      offY = y - wcsShift.y - (words.Y ?? (y - wcsShift.y))
      offZ = z - wcsShift.z - (words.Z ?? (z - wcsShift.z))
      continue
    }

    if (gCodes.includes(28)) {
      // Reference-return distance depends on the current machine position and
      // configured G28 point. It is omitted from the best-effort estimate.
      continue
    }

    const hasMove = 'X' in words || 'Y' in words || 'Z' in words
    const hasArcCenter = plane === 17
      ? ('I' in words || 'J' in words || 'R' in words)
      : plane === 18
        ? ('I' in words || 'K' in words || 'R' in words)
        : ('J' in words || 'K' in words || 'R' in words)
    const isArc = gCodes.includes(2) || gCodes.includes(3) || (arcMode > 0 && hasMove && hasArcCenter)

    if (hasMove || isArc) {
      const x0 = x, y0 = y, z0 = z

      if (incremental) {
        x += words.X ?? 0
        y += words.Y ?? 0
        z += words.Z ?? 0
      } else {
        x = (words.X ?? (x - wcsShift.x - offX)) + offX + wcsShift.x
        y = (words.Y ?? (y - wcsShift.y - offY)) + offY + wcsShift.y
        z = (words.Z ?? (z - wcsShift.z - offZ)) + offZ + wcsShift.z
      }

      expandBounds(x0, y0, z0)
      expandBounds(x, y, z)

      const moveType = getMoveType()
      const feedData = moveType === 'rapid'
        ? {}
        : feedRateMode === 93
          ? Number.isFinite(words.F) && words.F > 0
            ? { inverseTimeSeconds: 60 / words.F }
            : { timingUnknown: true }
          : feedRateMode === 95
            ? feedMmPerRev > 0 && spindleRpm != null && spindleRpm > 0
              ? { feedMmPerMin: feedMmPerRev * spindleRpm }
              : { timingUnknown: true }
          : feedMmPerMin > 0 ? { feedMmPerMin } : {}
      const toolData = activeTool == null ? {} : { tool: activeTool }

      if (isArc) {
        const cw = gCodes.includes(2) || (!gCodes.includes(3) && arcMode === 2)
        let i: number, j: number, k: number = 0
        if ('R' in words) {
          // R-format arc: compute offsets in the active plane.
          const R = words.R
          const [u0, v0, u1, v1] = plane === 17
            ? [x0, y0, x, y]
            : plane === 18 ? [x0, z0, x, z] : [y0, z0, y, z]
          const du = u1 - u0, dv = v1 - v0
          const d = Math.hypot(du, dv)
          if (d > 0) {
            const h = Math.sqrt(Math.max(0, R * R - (d * d) / 4))
            const sign = ((R > 0) !== cw) ? 1 : -1
            const offsetU = du / 2 + sign * h * (-dv / d)
            const offsetV = dv / 2 + sign * h * (du / d)
            if (plane === 17) { i = offsetU; j = offsetV; k = 0 }
            else if (plane === 18) { i = offsetU; j = 0; k = offsetV }
            else { i = 0; j = offsetU; k = offsetV }
          } else {
            i = 0; j = 0; k = 0
          }
        } else {
          i = words.I ?? 0
          j = words.J ?? 0
          k = words.K ?? 0
        }

        // Skip arcs with zero radius (degenerate)
        const r = Math.sqrt(i * i + j * j + k * k)
        if (r > 1e-6) {
          const isFullCircle = plane === 17
            ? Math.abs(x0 - x) < 1e-4 && Math.abs(y0 - y) < 1e-4
            : plane === 18
              ? Math.abs(x0 - x) < 1e-4 && Math.abs(z0 - z) < 1e-4
              : Math.abs(y0 - y) < 1e-4 && Math.abs(z0 - z) < 1e-4
          if (isFullCircle) {
            if (plane === 17) {
              const cx = x0 + i, cy = y0 + j
              expandBounds(cx + r, cy, z0)
              expandBounds(cx - r, cy, z0)
              expandBounds(cx, cy + r, z0)
              expandBounds(cx, cy - r, z0)
            } else if (plane === 18) {
              const cx = x0 + i, cz = z0 + k
              expandBounds(cx + r, y0, cz)
              expandBounds(cx - r, y0, cz)
              expandBounds(cx, y0, cz + r)
              expandBounds(cx, y0, cz - r)
            } else {
              const cy = y0 + j, cz = z0 + k
              expandBounds(x0, cy + r, cz)
              expandBounds(x0, cy - r, cz)
              expandBounds(x0, cy, cz + r)
              expandBounds(x0, cy, cz - r)
            }
          } else if (plane === 17) {
            // Expand G17 bounds to include cardinal extrema that fall within
            // the arc's sweep. Other planes retain endpoint bounds here.
            const cx = x0 + i, cy = y0 + j
            const sa = Math.atan2(y0 - cy, x0 - cx)
            const ea = Math.atan2(y - cy, x - cx)
            const TAU = Math.PI * 2
            const sweep = cw
              ? ((sa - ea) % TAU + TAU) % TAU
              : ((ea - sa) % TAU + TAU) % TAU
            for (let n = 0; n < 4; n++) {
              const angle = n * Math.PI / 2
              const delta = cw
                ? ((sa - angle) % TAU + TAU) % TAU
                : ((angle - sa) % TAU + TAU) % TAU
              if (delta <= sweep + 1e-9) {
                expandBounds(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, z0)
              }
            }
          }
          segments.push({ x0, y0, z0, x1: x, y1: y, z1: z, moveType, i, j, k, cw, sourceLine, ...(plane === 17 ? {} : { arcPlane: plane as 18 | 19 }), ...feedData, ...toolData })
        } else {
          // Treat degenerate arc as a line
          segments.push({ x0, y0, z0, x1: x, y1: y, z1: z, moveType, sourceLine, ...feedData, ...toolData })
        }
      } else {
        segments.push({ x0, y0, z0, x1: x, y1: y, z1: z, moveType, sourceLine, ...feedData, ...toolData })
      }
    }
  }

  // Handle degenerate case
  if (!isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = bounds.minZ = 0
    bounds.maxX = bounds.maxY = bounds.maxZ = 1
  }

  return {
    segments,
    tools: tools.size > 0 ? Array.from(tools.values()).sort((a, b) => a.number - b.number) : undefined,
    bounds,
    totalLines: lines.length,
    fixedDelays,
    spindleTransitions,
    timingEndLine,
  }
}
