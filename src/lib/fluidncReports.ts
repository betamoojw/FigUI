const AXIS_NAMES = ['x', 'y', 'z', 'a', 'b', 'c', 'u', 'v', 'w'] as const
const LIMIT_MASK_WIDTHS = [12, 18] as const

export interface ProbePoint {
  x: number
  y: number
  z: number
}

export interface LimitInputSnapshot {
  positive: string[]
  negative: string[]
  probe: boolean
  toolsetter: boolean
}

export function parseProbePoint(line: string): ProbePoint | null {
  const match = line.match(/^\[PRB:([^:\]]+):([01])\]$/i)
  if (!match || match[2] !== '1') return null

  const values = match[1].split(',').map(Number)
  if (values.length < 3 || values.some(value => !Number.isFinite(value))) return null
  return { x: values[0], y: values[1], z: values[2] }
}

function parseLimitMask(mask: string, width: number): string[] | null {
  const axisCount = width / 2
  const expected = [
    ...AXIS_NAMES.slice(0, axisCount),
    ...AXIS_NAMES.slice(0, axisCount).map(axis => axis.toUpperCase()),
  ]
  const active: string[] = []

  for (let index = 0; index < width; index++) {
    const value = mask[index] ?? ' '
    if (value === ' ') continue
    if (value !== expected[index]) return null
    active.push(value)
  }
  return active
}

function parseLimitSnapshotWithWidth(payload: string, width: number): LimitInputSnapshot | null {
  // FluidNC emits ": <positive-mask> <negative-mask>[ P][ T]". The masks use
  // MAX_N_AXIS characters for each motor, even when fewer axes are configured.
  if (payload[0] !== ' ') return null
  const positiveStart = 1
  const positiveEnd = positiveStart + width
  const negativeStart = positiveEnd + 1
  const negativeEnd = negativeStart + width
  if (payload.length > positiveEnd && payload[positiveEnd] !== ' ') return null

  const positive = parseLimitMask(payload.slice(positiveStart, positiveEnd), width)
  const negative = parseLimitMask(payload.slice(negativeStart, negativeEnd), width)
  if (!positive || !negative) return null

  const suffix = payload.slice(negativeEnd).trim()
  if (suffix && !/^(?:P(?:\s+T)?|T)$/.test(suffix)) return null
  const inputs = suffix.split(/\s+/).filter(Boolean)
  return {
    positive,
    negative,
    probe: inputs.includes('P'),
    toolsetter: inputs.includes('T'),
  }
}

export function parseLimitSnapshotLine(line: string): LimitInputSnapshot | null {
  if (!line.startsWith(':')) return null
  if (line === ':') {
    return { positive: [], negative: [], probe: false, toolsetter: false }
  }
  const payload = line.slice(1)

  for (const width of LIMIT_MASK_WIDTHS) {
    const parsed = parseLimitSnapshotWithWidth(payload, width)
    if (parsed) return parsed
  }
  return null
}
