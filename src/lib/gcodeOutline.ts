import type { GCodeModel, Segment } from './gcode'
import { getArcGeometry } from './gcodeBuild'

export type FramingMode = 'rectangle' | 'contour'

export interface FramingOptions {
  mode: FramingMode
  feedMmPerMin: number
  clearanceMm: number
  travelZMm: number
}

interface Point {
  x: number
  y: number
}

interface CutEnvelope {
  minX: number
  minY: number
  maxX: number
  maxY: number
  maxCuttingZ: number
  points: Point[]
  closedContours: Point[][]
}

const ARC_SAMPLE_TARGET_MM = 1.5
const ARC_SAMPLE_MAX = 96
const POINT_KEY_SCALE = 1000
const CONNECT_TOLERANCE_MM = 0.001
const XY_MOVE_TOLERANCE_MM = 0.001
const Z_APPROACH_FEED_MAX_MM_PER_MIN = 200

export function buildFramingGCode(model: GCodeModel, options: FramingOptions): string | null {
  const envelope = getCutEnvelope(model.segments)
  if (!envelope) return null

  const path = options.mode === 'rectangle'
    ? rectanglePath(envelope)
    : exteriorContour(envelope) ?? convexHull(envelope.points)

  if (path.length < 2) return null

  const frameZ = envelope.maxCuttingZ + options.clearanceMm
  if (!Number.isFinite(options.travelZMm)) throw new Error('Safe travel height must be valid.')
  if (options.travelZMm < frameZ) {
    throw new Error(
      `Safe travel height must be at least ${format(frameZ, 3)} mm. `
      + `The highest XY cutting Z is ${format(envelope.maxCuttingZ, 3)} mm, plus ${format(options.clearanceMm, 3)} mm clearance from top.`,
    )
  }
  const feed = Math.max(1, options.feedMmPerMin)
  const zApproachFeed = Math.min(feed, Z_APPROACH_FEED_MAX_MM_PER_MIN)
  const closedPath = closePath(path)
  const lines = [
    '(FluidUI framing routine)',
    `(${options.mode === 'rectangle' ? 'Rectangle' : 'Contour'} outline from cutting moves only)`,
    'G21 G90 G94',
    `G0 Z${format(options.travelZMm, 3)}`,
    `G0 X${format(closedPath[0].x, 3)} Y${format(closedPath[0].y, 3)}`,
    `G1 F${format(zApproachFeed, 1)}`,
    `G1 Z${format(frameZ, 3)}`,
    `G1 F${format(feed, 1)}`,
    ...closedPath.slice(1).map(point => `G1 X${format(point.x, 3)} Y${format(point.y, 3)}`),
    `G0 Z${format(options.travelZMm, 3)}`,
    'M2',
  ]
  return lines.join('\n')
}

function getCutEnvelope(segments: Segment[]): CutEnvelope | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxCuttingZ = -Infinity
  const points: Point[] = []
  const closedContours: Point[][] = []
  const seen = new Set<string>()
  let activeContour: Point[] = []

  function addPoint(x: number, y: number) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    const key = `${Math.round(x * POINT_KEY_SCALE)},${Math.round(y * POINT_KEY_SCALE)}`
    if (!seen.has(key)) {
      seen.add(key)
      points.push({ x, y })
    }
  }

  function captureClosedSuffix() {
    if (activeContour.length < 4) return
    const last = activeContour[activeContour.length - 1]
    // CAM lead-ins mean a real profile often closes at a point in the middle
    // of a continuous feed chain rather than at the chain's first point.
    // Recover that embedded cycle and leave any following lead-out separate.
    for (let index = activeContour.length - 2; index >= 0; index--) {
      if (!pointsEqual(activeContour[index], last)) continue
      const contour = activeContour.slice(index, -1)
      if (contour.length >= 3 && Math.abs(signedArea(contour)) > CONNECT_TOLERANCE_MM ** 2) {
        closedContours.push(contour)
        activeContour = [{ ...last }]
      }
      return
    }
  }

  for (const seg of segments) {
    if (seg.moveType !== 'feed' || !isXYCuttingMove(seg)) {
      activeContour = []
      continue
    }

    maxCuttingZ = Math.max(maxCuttingZ, seg.z0, seg.z1)
    const segmentPoints: Point[] = [{ x: seg.x0, y: seg.y0 }]
    if (seg.i !== undefined) {
      const arc = getArcGeometry(seg)
      const samples = Math.max(8, Math.min(ARC_SAMPLE_MAX, Math.ceil((arc.sweep * arc.r) / ARC_SAMPLE_TARGET_MM)))
      for (let index = 1; index < samples; index++) {
        const fraction = index / samples
        const angle = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * fraction
        segmentPoints.push({
          x: arc.cx + Math.cos(angle) * arc.r,
          y: arc.cy + Math.sin(angle) * arc.r,
        })
      }
    }
    segmentPoints.push({ x: seg.x1, y: seg.y1 })

    if (activeContour.length > 0 && !pointsEqual(activeContour[activeContour.length - 1], segmentPoints[0])) {
      activeContour = []
    }
    for (const point of segmentPoints) {
      addPoint(point.x, point.y)
      if (activeContour.length === 0 || !pointsEqual(activeContour[activeContour.length - 1], point)) {
        activeContour.push({ x: point.x, y: point.y })
      }
    }
    captureClosedSuffix()
  }
  if (!Number.isFinite(minX) || points.length === 0) return null
  return { minX, minY, maxX, maxY, maxCuttingZ, points, closedContours }
}

function isXYCuttingMove(seg: Segment) {
  if (seg.i !== undefined) return true
  return (seg.x1 - seg.x0) ** 2 + (seg.y1 - seg.y0) ** 2 > XY_MOVE_TOLERANCE_MM ** 2
}

function rectanglePath(bounds: Pick<CutEnvelope, 'minX' | 'minY' | 'maxX' | 'maxY'>): Point[] {
  if (Math.abs(bounds.maxX - bounds.minX) < 1e-6 && Math.abs(bounds.maxY - bounds.minY) < 1e-6) {
    return [{ x: bounds.minX, y: bounds.minY }]
  }
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ]
}

/**
 * Prefer the smallest closed cutting contour that encloses every cutting
 * point. Unlike a convex hull, this preserves concave exterior edges. If the
 * file has no single enclosing closed contour (for example, separate parts or
 * an open toolpath), the caller falls back to the conservative convex hull.
 */
function exteriorContour(envelope: Pick<CutEnvelope, 'points' | 'closedContours'>): Point[] | null {
  let result: Point[] | null = null
  let resultArea = Infinity
  for (const contour of envelope.closedContours) {
    const area = Math.abs(signedArea(contour))
    if (area < resultArea && envelope.points.every(point => pointInOrOnPolygon(point, contour))) {
      result = contour
      resultArea = area
    }
  }
  return result
}

function signedArea(points: Point[]) {
  let area = 0
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length]
    area += points[index].x * next.y - next.x * points[index].y
  }
  return area / 2
}

function pointInOrOnPolygon(point: Point, polygon: Point[]) {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous]
    const b = polygon[index]
    if (Math.abs(cross(a, b, point)) <= CONNECT_TOLERANCE_MM
      && point.x >= Math.min(a.x, b.x) - CONNECT_TOLERANCE_MM
      && point.x <= Math.max(a.x, b.x) + CONNECT_TOLERANCE_MM
      && point.y >= Math.min(a.y, b.y) - CONNECT_TOLERANCE_MM
      && point.y <= Math.max(a.y, b.y) + CONNECT_TOLERANCE_MM) return true
    if ((a.y > point.y) !== (b.y > point.y)) {
      const crossingX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < crossingX) inside = !inside
    }
  }
  return inside
}

function pointsEqual(a: Point, b: Point) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= CONNECT_TOLERANCE_MM ** 2
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x)
  if (sorted.length <= 1) return sorted

  const lower: Point[] = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop()
    }
    lower.push(point)
  }

  const upper: Point[] = []
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop()
    }
    upper.push(point)
  }

  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function cross(origin: Point, a: Point, b: Point) {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

function closePath(path: Point[]) {
  if (path.length === 0) return path
  const first = path[0]
  const last = path[path.length - 1]
  if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) return path
  return [...path, first]
}

const format = (value: number, digits: number) => String(+value.toFixed(digits))
