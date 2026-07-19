import type { Segment } from './gcode'

const TAU = Math.PI * 2
export const EMPTY_FLOAT32 = new Float32Array(0)

const TWO_D_BUILD_CHUNK_SIZE = 2000
const THREE_D_BUILD_CHUNK_SIZE = 1500
const TOOL_COLORS = [
  [0.94, 0.63, 0.19, 1.0],
  [0.20, 0.68, 0.90, 1.0],
  [0.86, 0.44, 0.78, 1.0],
  [0.28, 0.78, 0.48, 1.0],
  [0.96, 0.38, 0.32, 1.0],
  [0.62, 0.52, 0.96, 1.0],
  [0.88, 0.76, 0.24, 1.0],
  [0.36, 0.78, 0.74, 1.0],
] as const

function toolColorIndex(tool: number) {
  const abs = Math.abs(tool)
  return (abs > 0 ? abs - 1 : 0) % TOOL_COLORS.length
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function normalizeAngle(angle: number) {
  return ((angle % TAU) + TAU) % TAU
}

export function getArcGeometry(seg: Segment) {
  const cx = seg.x0 + (seg.i ?? 0)
  const cy = seg.y0 + (seg.j ?? 0)
  const r = Math.sqrt((seg.i ?? 0) ** 2 + (seg.j ?? 0) ** 2)
  const startAngle = Math.atan2(seg.y0 - cy, seg.x0 - cx)
  const endAngle = Math.atan2(seg.y1 - cy, seg.x1 - cx)
  const fullCircle = Math.abs(seg.x0 - seg.x1) < 1e-4 && Math.abs(seg.y0 - seg.y1) < 1e-4
  let sweep = seg.cw
    ? normalizeAngle(startAngle - endAngle)
    : normalizeAngle(endAngle - startAngle)
  if (fullCircle) sweep = TAU
  return { cx, cy, r, startAngle, endAngle, sweep, fullCircle }
}

export function addSegmentToPath(path: Path2D, seg: Segment) {
  if (seg.i !== undefined) {
    const arc = getArcGeometry(seg)
    const numSubs = Math.max(8, Math.min(64, Math.ceil(arc.sweep * arc.r * 4)))
    for (let i = 0; i < numSubs; i++) {
      const t1 = i / numSubs
      const t2 = (i + 1) / numSubs
      const angle1 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t1
      const angle2 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t2
      path.moveTo(
        arc.cx + Math.cos(angle1) * arc.r,
        arc.cy + Math.sin(angle1) * arc.r,
      )
      path.lineTo(
        arc.cx + Math.cos(angle2) * arc.r,
        arc.cy + Math.sin(angle2) * arc.r,
      )
    }
    return
  }

  path.moveTo(seg.x0, seg.y0)
  path.lineTo(seg.x1, seg.y1)
}

function appendStatic3DPathSegment(
  vertices: number[],
  colors: number[],
  seg: Segment,
  showRapids: boolean,
  hiddenTools?: Set<number>,
) {
  if (seg.moveType === 'rapid' && !showRapids) return
  if (seg.moveType === 'traverse' && !showRapids) return
  if (seg.tool != null && hiddenTools?.has(seg.tool)) return

  const RAPID_C     = [0.4,  0.5,  0.7,  1.0] as const
  const TRAVERSE_C  = [0.35, 0.6,  0.35, 0.7] as const
  const CUT_C       = [0.94, 0.63, 0.19, 1.0] as const
  const color = seg.moveType === 'rapid'
    ? RAPID_C
    : seg.moveType === 'traverse'
      ? TRAVERSE_C
      : seg.tool == null ? CUT_C : TOOL_COLORS[toolColorIndex(seg.tool)]

  if (seg.i !== undefined) {
    const arc = getArcGeometry(seg)
    const numSubs = Math.max(8, Math.min(64, Math.ceil(arc.sweep * arc.r * 4)))
    for (let i = 0; i < numSubs; i++) {
      const t1 = i / numSubs
      const t2 = (i + 1) / numSubs
      const angle1 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t1
      const angle2 = arc.startAngle + (seg.cw ? -1 : 1) * arc.sweep * t2
      vertices.push(
        arc.cx + Math.cos(angle1) * arc.r, arc.cy + Math.sin(angle1) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t1,
        arc.cx + Math.cos(angle2) * arc.r, arc.cy + Math.sin(angle2) * arc.r, seg.z0 + (seg.z1 - seg.z0) * t2,
      )
      colors.push(...color, ...color)
    }
    return
  }

  vertices.push(seg.x0, seg.y0, seg.z0, seg.x1, seg.y1, seg.z1)
  colors.push(...color, ...color)
}

export function nextAnimationFrame() {
  return new Promise<void>(resolve => {
    requestAnimationFrame(() => resolve())
  })
}

export interface Built2DPaths {
  rapidPath: Path2D
  traversePath: Path2D
  cutPath: Path2D
  toolPaths?: Array<{
    tool: number | null
    rapidPath: Path2D
    traversePath: Path2D
    cutPath: Path2D
  }>
}

export async function buildStatic2DPathsAsync(
  segments: Segment[],
  onProgress: (progress: number) => void,
  shouldContinue: () => boolean,
): Promise<Built2DPaths> {
  const rapidPath = new Path2D()
  const traversePath = new Path2D()
  const cutPath = new Path2D()
  const hasTools = segments.some(seg => seg.tool != null)
  const byTool = hasTools
    ? new Map<number | null, { tool: number | null; rapidPath: Path2D; traversePath: Path2D; cutPath: Path2D }>()
    : null

  function pathsForTool(tool: number | null) {
    let paths = byTool?.get(tool)
    if (!paths && byTool) {
      paths = { tool, rapidPath: new Path2D(), traversePath: new Path2D(), cutPath: new Path2D() }
      byTool.set(tool, paths)
    }
    return paths
  }

  if (segments.length === 0) {
    onProgress(100)
    return { rapidPath, traversePath, cutPath }
  }

  for (let start = 0; start < segments.length; start += TWO_D_BUILD_CHUNK_SIZE) {
    if (!shouldContinue()) throw new Error('stale-load')

    const end = Math.min(start + TWO_D_BUILD_CHUNK_SIZE, segments.length)
    for (let i = start; i < end; i++) {
      const seg = segments[i]
      const path = seg.moveType === 'rapid' ? rapidPath : seg.moveType === 'traverse' ? traversePath : cutPath
      addSegmentToPath(path, seg)
      const toolPaths = pathsForTool(seg.tool ?? null)
      if (toolPaths) {
        const toolPath = seg.moveType === 'rapid' ? toolPaths.rapidPath : seg.moveType === 'traverse' ? toolPaths.traversePath : toolPaths.cutPath
        addSegmentToPath(toolPath, seg)
      }
    }

    onProgress(Math.round((end / segments.length) * 100))
    if (end < segments.length) await nextAnimationFrame()
  }

  return {
    rapidPath,
    traversePath,
    cutPath,
    toolPaths: byTool ? Array.from(byTool.values()).sort((a, b) => (a.tool ?? -1) - (b.tool ?? -1)) : undefined,
  }
}

export interface Built3DGeometry {
  vertices: Float32Array
  colors: Float32Array
}

export async function buildStatic3DGeometryAsync(
  segments: Segment[],
  showRapids: boolean,
  onProgress: (progress: number) => void,
  shouldContinue: () => boolean,
  hiddenTools?: Set<number>,
): Promise<Built3DGeometry> {
  const vertices: number[] = []
  const colors: number[] = []

  if (segments.length === 0) {
    onProgress(100)
    return { vertices: EMPTY_FLOAT32, colors: EMPTY_FLOAT32 }
  }

  for (let start = 0; start < segments.length; start += THREE_D_BUILD_CHUNK_SIZE) {
    if (!shouldContinue()) throw new Error('stale-load')

    const end = Math.min(start + THREE_D_BUILD_CHUNK_SIZE, segments.length)
    for (let i = start; i < end; i++) {
      appendStatic3DPathSegment(vertices, colors, segments[i], showRapids, hiddenTools)
    }

    onProgress(Math.round((end / segments.length) * 100))
    if (end < segments.length) await nextAnimationFrame()
  }

  return {
    vertices: new Float32Array(vertices),
    colors: new Float32Array(colors),
  }
}
