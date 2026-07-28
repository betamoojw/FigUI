import { useEffect, useMemo, useRef, useState } from 'react'
import type { ControllerSettings, MachineStatus } from '../types'
import type { GCodeModel, Segment } from './gcode'

interface SegmentMotionProfile {
  lengthMm: number
  axisFractions: { x: number; y: number; z: number }
  /** Axis acceleration per path-speed squared while following an arc. */
  centripetalFactors?: { x: number; y: number; z: number }

  entryDir: { x: number; y: number; z: number }
  exitDir: { x: number; y: number; z: number }
}

export interface JobTimingEstimate {
  /** Motion time only; fixed delays are stored separately. */
  segmentSeconds: Float64Array
  delayBeforeSegmentSeconds: Float64Array
  /** Start time of every segment; the final entry is the end of the last motion, excluding trailing waits. */
  timelineSeconds: Float64Array
  trailingDelaySeconds: number
  totalSeconds: number
}

export interface JobRuntimeEstimate {
  source: 'estimated' | 'sd' | 'none'
  progressPercent: number | null
  elapsedSeconds: number | null
  remainingSeconds: number | null
  totalSeconds: number | null
}

export interface LocalJobRuntimeContext {
  active: boolean
  key: string
}

const timingCache = new WeakMap<GCodeModel, Map<string, JobTimingEstimate>>()

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function getOverrideScale(percent: number | undefined) {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return 1
  return Math.max(percent / 100, 0.01)
}

function motionSettingsKey(settings: ControllerSettings) {
  return [
    settings.maxRateX ?? '',
    settings.maxRateY ?? '',
    settings.maxRateZ ?? '',
    settings.accelX ?? '',
    settings.accelY ?? '',
    settings.accelZ ?? '',
    settings.junctionDeviation ?? '',
    settings.spindleSpinupMs ?? '',
    settings.spindleSpindownMs ?? '',
  ].join('|')
}

export interface JobTimingOverrides {
  feedPercent?: number
  rapidPercent?: number
}

function angleFallsWithinSweep(angle: number, startAngle: number, sweep: number, cw: boolean) {
  const tau = Math.PI * 2
  if (sweep >= tau - 1e-9) return true
  const delta = cw
    ? ((startAngle - angle) % tau + tau) % tau
    : ((angle - startAngle) % tau + tau) % tau
  return delta <= sweep + 1e-9
}

function getSegmentMotionProfile(seg: Segment): SegmentMotionProfile | null {
  if (seg.i === undefined) {
    const dx = seg.x1 - seg.x0
    const dy = seg.y1 - seg.y0
    const dz = seg.z1 - seg.z0
    const lengthMm = Math.hypot(dx, dy, dz)
    if (lengthMm < 1e-9) return null
    const ux = dx / lengthMm
    const uy = dy / lengthMm
    const uz = dz / lengthMm
    const dir = { x: ux, y: uy, z: uz }
    return {
      lengthMm,
      axisFractions: {
        x: Math.abs(ux),
        y: Math.abs(uy),
        z: Math.abs(uz),
      },
      entryDir: dir,
      exitDir: dir,
    }
  }

  const plane = seg.arcPlane ?? 17
  const [u0, v0, u1, v1, w0, w1, offsetU, offsetV] = plane === 17
    ? [seg.x0, seg.y0, seg.x1, seg.y1, seg.z0, seg.z1, seg.i ?? 0, seg.j ?? 0]
    : plane === 18
      ? [seg.x0, seg.z0, seg.x1, seg.z1, seg.y0, seg.y1, seg.i ?? 0, seg.k ?? 0]
      : [seg.y0, seg.z0, seg.y1, seg.z1, seg.x0, seg.x1, seg.j ?? 0, seg.k ?? 0]
  const r = Math.hypot(offsetU, offsetV)
  if (r < 1e-9) return null
  const cu = u0 + offsetU
  const cv = v0 + offsetV
  const startAngle = Math.atan2(v0 - cv, u0 - cu)
  const endAngle = Math.atan2(v1 - cv, u1 - cu)
  const fullCircle = Math.abs(u0 - u1) < 1e-4 && Math.abs(v0 - v1) < 1e-4
  const sweep = seg.cw
    ? ((startAngle - endAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
    : ((endAngle - startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
  const arcSweep = fullCircle ? Math.PI * 2 : sweep
  const planeLength = r * arcSweep
  const dw = w1 - w0
  const lengthMm = Math.hypot(planeLength, dw)
  if (lengthMm < 1e-9) return null

  const dirSign = seg.cw ? -1 : 1
  const terminalAngle = startAngle + dirSign * arcSweep

  const tangentAt = (angle: number) => ({
    x: seg.cw ? Math.sin(angle) : -Math.sin(angle),
    y: seg.cw ? -Math.cos(angle) : Math.cos(angle),
  })

  const planeScale = planeLength / lengthMm
  const normalComponent = dw / lengthMm

  const mapAxes = (u: number, v: number, w: number) => plane === 17
    ? { x: u, y: v, z: w }
    : plane === 18
      ? { x: u, y: w, z: v }
      : { x: w, y: u, z: v }

  const buildDir = (angle: number) => {
    const t = tangentAt(angle)
    return mapAxes(t.x * planeScale, t.y * planeScale, normalComponent)
  }

  // An arc's limiting axis can occur anywhere in its sweep. Sampling only the
  // midpoint makes an identical circle change speed when its start point is
  // rotated. Evaluate the endpoint tangents and every component extremum.
  const candidates = [startAngle, terminalAngle, 0, Math.PI / 2, Math.PI, Math.PI * 1.5]
    .filter(angle => angleFallsWithinSweep(angle, startAngle, arcSweep, !!seg.cw))
  let maxTangentU = 0
  let maxTangentV = 0
  let maxRadialU = 0
  let maxRadialV = 0
  for (const angle of candidates) {
    const tangent = tangentAt(angle)
    maxTangentU = Math.max(maxTangentU, Math.abs(tangent.x))
    maxTangentV = Math.max(maxTangentV, Math.abs(tangent.y))
    maxRadialU = Math.max(maxRadialU, Math.abs(Math.cos(angle)))
    maxRadialV = Math.max(maxRadialV, Math.abs(Math.sin(angle)))
  }

  return {
    lengthMm,
    axisFractions: mapAxes(maxTangentU * planeScale, maxTangentV * planeScale, Math.abs(normalComponent)),
    // At path speed v, a helical arc needs v² * xyScale² / r of normal
    // acceleration. This small constraint prevents impossible tiny-radius arcs
    // from being timed as if they were straight lines.
    centripetalFactors: mapAxes(maxRadialU * planeScale * planeScale / r, maxRadialV * planeScale * planeScale / r, 0),
    entryDir: buildDir(startAngle),
    exitDir: buildDir(terminalAngle),
  }
}

function getAxisLimitedValue(
  axisFractions: SegmentMotionProfile['axisFractions'],
  xLimit?: number,
  yLimit?: number,
  zLimit?: number,
) {
  let limit = Number.POSITIVE_INFINITY

  if (axisFractions.x > 1e-6 && xLimit != null && Number.isFinite(xLimit) && xLimit > 0) {
    limit = Math.min(limit, xLimit / axisFractions.x)
  }
  if (axisFractions.y > 1e-6 && yLimit != null && Number.isFinite(yLimit) && yLimit > 0) {
    limit = Math.min(limit, yLimit / axisFractions.y)
  }
  if (axisFractions.z > 1e-6 && zLimit != null && Number.isFinite(zLimit) && zLimit > 0) {
    limit = Math.min(limit, zLimit / axisFractions.z)
  }

  return limit
}

function segmentTimeWithEndpoints(
  lengthMm: number,
  vMax: number,
  accel: number,
  v0: number,
  v1: number,
): number {
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) return 0
  if (!Number.isFinite(vMax) || vMax <= 0) return 0

  if (!Number.isFinite(accel) || accel <= 1e-6) {
    return lengthMm / vMax
  }

  const v0c = Math.max(0, Math.min(v0, vMax))
  const v1c = Math.max(0, Math.min(v1, vMax))

  const dAccel = Math.max(0, (vMax * vMax - v0c * v0c) / (2 * accel))
  const dDecel = Math.max(0, (vMax * vMax - v1c * v1c) / (2 * accel))

  if (dAccel + dDecel <= lengthMm) {
    // Full trapezoid.
    const cruiseDist = lengthMm - dAccel - dDecel
    const tAccel = (vMax - v0c) / accel
    const tDecel = (vMax - v1c) / accel
    const tCruise = cruiseDist / vMax
    return tAccel + tCruise + tDecel
  }

  const vpSquared = accel * lengthMm + (v0c * v0c + v1c * v1c) / 2
  if (vpSquared <= v0c * v0c) {
    const vAvg = (v0c + v1c) / 2
    return vAvg > 1e-9 ? lengthMm / vAvg : 0
  }
  const vp = Math.sqrt(vpSquared)
  const tAccel = (vp - v0c) / accel
  const tDecel = (vp - v1c) / accel
  return tAccel + tDecel
}

function computeJunctionSpeed(
  exitDirA: { x: number; y: number; z: number },
  entryDirB: { x: number; y: number; z: number },
  accel: number,
  junctionDeviationMm: number,
): number {
  if (!Number.isFinite(accel) || accel <= 1e-6) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(junctionDeviationMm) || junctionDeviationMm <= 0) {
    return Number.POSITIVE_INFINITY
  }

  const cosTheta = Math.max(-1, Math.min(1,
    exitDirA.x * entryDirB.x + exitDirA.y * entryDirB.y + exitDirA.z * entryDirB.z,
  ))

  if (cosTheta >= 0.999999) return Number.POSITIVE_INFINITY // colinear
  if (cosTheta <= -0.999999) return 0 // reversal

  // GRBL's junction-deviation derivation uses the supplementary angle between
  // consecutive path vectors. A nearly straight path must therefore approach
  // one here (and have no junction cap), while a reversal approaches zero.
  const sinHalf = Math.sqrt((1 + cosTheta) / 2)
  if (sinHalf >= 0.999999) return Number.POSITIVE_INFINITY
  const vSquared = (accel * junctionDeviationMm * sinHalf) / (1 - sinHalf)
  return Math.sqrt(Math.max(0, vSquared)) * 60 // convert mm/s back to mm/min
}

interface PlannedSegment {
  profile: SegmentMotionProfile
  vMax: number
  accel: number
  vEntry: number
  vExit: number 
}

export function distributeFixedDelays(model: GCodeModel, target: Float64Array, settings?: ControllerSettings) {
  let trailing = 0
  let total = 0
  let segmentIndex = 0
  const delays = [...(model.fixedDelays ?? [])]
  const spinupSeconds = (settings?.spindleSpinupMs ?? 0) / 1000
  const spindownSeconds = (settings?.spindleSpindownMs ?? 0) / 1000
  for (const [sourceLine, state] of model.spindleTransitions ?? []) {
    const seconds = state === 'on' ? spinupSeconds : spindownSeconds
    if (Number.isFinite(seconds) && seconds > 0) delays.push([sourceLine, seconds])
  }
  delays.sort((a, b) => a[0] - b[0])
  for (const [sourceLine, seconds] of delays) {
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    if (model.timingEndLine != null && sourceLine > model.timingEndLine) continue
    while (segmentIndex < model.segments.length
      && model.segments[segmentIndex].sourceLine < sourceLine) segmentIndex++
    if (segmentIndex < model.segments.length) target[segmentIndex] += seconds
    else trailing += seconds
    total += seconds
  }
  return [trailing, total] as const
}

function getStopsBeforeSegments(model: GCodeModel, settings: ControllerSettings) {
  const stops = new Uint8Array(model.segments.length)
  let segmentIndex = 0
  const delays = [...(model.fixedDelays ?? [])]
  const spinupSeconds = (settings.spindleSpinupMs ?? 0) / 1000
  const spindownSeconds = (settings.spindleSpindownMs ?? 0) / 1000
  for (const [sourceLine, state] of model.spindleTransitions ?? []) {
    const seconds = state === 'on' ? spinupSeconds : spindownSeconds
    if (Number.isFinite(seconds) && seconds > 0) delays.push([sourceLine, seconds])
  }
  delays.sort((a, b) => a[0] - b[0])
  for (const [sourceLine, seconds] of delays) {
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    if (model.timingEndLine != null && sourceLine > model.timingEndLine) continue
    while (segmentIndex < model.segments.length
      && model.segments[segmentIndex].sourceLine < sourceLine) segmentIndex++
    if (segmentIndex < stops.length) stops[segmentIndex] = 1
  }
  return stops
}

export function buildJobTimingEstimate(
  model: GCodeModel,
  settings: ControllerSettings,
  overrides: JobTimingOverrides = {},
): JobTimingEstimate | null {
  const feedScale = getOverrideScale(overrides.feedPercent)
  const rapidScale = getOverrideScale(overrides.rapidPercent)
  const key = `${motionSettingsKey(settings)}|${feedScale}|${rapidScale}`
  let byKey = timingCache.get(model)
  if (!byKey) {
    byKey = new Map()
    timingCache.set(model, byKey)
  }

  const cached = byKey.get(key)
  if (cached) return cached

  const junctionDeviation = Number.isFinite(settings.junctionDeviation) && (settings.junctionDeviation ?? 0) > 0
    ? (settings.junctionDeviation as number)
    : 0.01 // GRBL default ($11)

  const planned: (PlannedSegment | null)[] = new Array(model.segments.length)
  const stopsBefore = getStopsBeforeSegments(model, settings)
  for (let i = 0; i < model.segments.length; i++) {
    const seg = model.segments[i]
    if (model.timingEndLine != null && seg.sourceLine > model.timingEndLine) {
      planned[i] = null
      continue
    }
    if (seg.timingUnknown) return null
    const profile = getSegmentMotionProfile(seg)
    if (!profile) {
      planned[i] = null
      continue
    }

    const maxSpeed = getAxisLimitedValue(
      profile.axisFractions,
      settings.maxRateX,
      settings.maxRateY,
      settings.maxRateZ,
    )
    const accel = getAxisLimitedValue(
      profile.axisFractions,
      settings.accelX,
      settings.accelY,
      settings.accelZ,
    )
    const isRapid = seg.moveType === 'rapid'
    const programmedSpeed = isRapid
      ? maxSpeed * rapidScale
      : (seg.inverseTimeSeconds != null
          ? profile.lengthMm * 60 / seg.inverseTimeSeconds
          : (seg.feedMmPerMin ?? maxSpeed)) * feedScale
    const curveSpeedMmS = profile.centripetalFactors
      ? Math.sqrt(getAxisLimitedValue(
          profile.centripetalFactors,
          settings.accelX,
          settings.accelY,
          settings.accelZ,
        ))
      : Number.POSITIVE_INFINITY
    const vMax = Math.min(programmedSpeed, maxSpeed, curveSpeedMmS * 60)

    if (!Number.isFinite(vMax) || vMax <= 0) {
      planned[i] = null
      continue
    }

    planned[i] = {
      profile,
      vMax,
      accel: Number.isFinite(accel) && accel > 0 ? accel : 0,
      vEntry: 0,
      vExit: 0,
    }
  }

  let nextEntrySpeed = 0
  let nextEntryDir: { x: number; y: number; z: number } | null = null
  for (let i = planned.length - 1; i >= 0; i--) {
    const cur = planned[i]
    if (!cur) continue

    let exitCap: number
    if (nextEntryDir === null) {
      exitCap = 0
    } else {
      const junctionLimit = computeJunctionSpeed(
        cur.profile.exitDir,
        nextEntryDir,
        cur.accel,
        junctionDeviation,
      )
      exitCap = Math.min(cur.vMax, junctionLimit, nextEntrySpeed)
    }
    cur.vExit = exitCap

    let vEntryMax = cur.vMax
    if (cur.accel > 0) {
      const vExitMmS = exitCap / 60
      const vEntryMaxMmS = Math.sqrt(vExitMmS * vExitMmS + 2 * cur.accel * cur.profile.lengthMm)
      vEntryMax = Math.min(cur.vMax, vEntryMaxMmS * 60)
    }
    cur.vEntry = stopsBefore[i] ? 0 : vEntryMax

    nextEntrySpeed = cur.vEntry
    nextEntryDir = cur.profile.entryDir
  }

  let prevExitSpeed = 0 // start from rest
  for (let i = 0; i < planned.length; i++) {
    const cur = planned[i]
    if (!cur) continue

    cur.vEntry = Math.min(cur.vEntry, prevExitSpeed)

    if (cur.accel > 0) {
      const vEntryMmS = cur.vEntry / 60
      const vExitFwdMmS = Math.sqrt(vEntryMmS * vEntryMmS + 2 * cur.accel * cur.profile.lengthMm)
      cur.vExit = Math.min(cur.vExit, vExitFwdMmS * 60, cur.vMax)
    } else {
      cur.vExit = Math.min(cur.vExit, cur.vMax)
    }

    prevExitSpeed = cur.vExit
  }

  const segmentSeconds = new Float64Array(model.segments.length)
  let totalSeconds = 0
  let hasEstimate = false

  for (let i = 0; i < planned.length; i++) {
    const cur = planned[i]
    if (!cur) {
      segmentSeconds[i] = 0
      continue
    }

    const vMaxMmS = cur.vMax / 60
    const vEntryMmS = cur.vEntry / 60
    const vExitMmS = cur.vExit / 60
    const seconds = segmentTimeWithEndpoints(
      cur.profile.lengthMm,
      vMaxMmS,
      cur.accel,
      vEntryMmS,
      vExitMmS,
    )
    segmentSeconds[i] = seconds
    totalSeconds += seconds
    if (seconds > 0) hasEstimate = true
  }

  if (!hasEstimate || totalSeconds <= 0) return null

  const delayBeforeSegmentSeconds = new Float64Array(model.segments.length)
  const [trailingDelaySeconds, totalFixedSeconds] = distributeFixedDelays(model, delayBeforeSegmentSeconds, settings)
  totalSeconds += totalFixedSeconds

  const timelineSeconds = new Float64Array(model.segments.length + 1)
  for (let i = 0; i < model.segments.length; i++) {
    timelineSeconds[i + 1] = timelineSeconds[i]
      + delayBeforeSegmentSeconds[i]
      + segmentSeconds[i]
  }
  const estimate = {
    segmentSeconds,
    delayBeforeSegmentSeconds,
    timelineSeconds,
    trailingDelaySeconds,
    totalSeconds,
  }
  byKey.set(key, estimate)
  return estimate
}

function getBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function fileMatchesJob(status: MachineStatus, loadedPath: string | null, fileName: string | null) {
  const jobFile = status.sdFilename
  if (!jobFile) return false

  const jobBaseName = getBasename(jobFile)

  if (loadedPath && (loadedPath === jobFile || loadedPath.replace(/\\/g, '/') === jobFile.replace(/\\/g, '/'))) {
    return true
  }

  if (fileName && fileName === jobBaseName) return true
  if (loadedPath && getBasename(loadedPath) === jobBaseName) return true

  return false
}

export function formatRuntime(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--'
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const secs = rounded % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

interface TimelinePosition {
  overriddenElapsedSeconds: number
  nominalSecondsPerActualSecond: number
}

/**
 * Map a point on the nominal timeline to the same point on an overridden
 * timeline. Delays map one-to-one; a motion block maps by its local fraction.
 * This avoids treating a feed override as a whole-job average.
 */
function getTimelinePosition(
  nominal: JobTimingEstimate,
  overridden: JobTimingEstimate,
  nominalElapsedSeconds: number,
): TimelinePosition {
  const nominalElapsed = Math.max(0, Math.min(nominalElapsedSeconds, nominal.totalSeconds))
  const segmentCount = nominal.segmentSeconds.length

  if (nominalElapsed >= nominal.timelineSeconds[segmentCount]) {
    const trailingElapsed = nominalElapsed - nominal.timelineSeconds[segmentCount]
    return {
      overriddenElapsedSeconds: Math.min(overridden.totalSeconds, overridden.timelineSeconds[segmentCount] + trailingElapsed),
      nominalSecondsPerActualSecond: 1,
    }
  }

  let low = 0
  let high = segmentCount - 1
  while (low < high) {
    const mid = (low + high) >>> 1
    if (nominal.timelineSeconds[mid + 1] <= nominalElapsed) low = mid + 1
    else high = mid
  }

  const index = low
  const offset = nominalElapsed - nominal.timelineSeconds[index]
  const nominalDelay = nominal.delayBeforeSegmentSeconds[index]
  if (offset <= nominalDelay) {
    return {
      overriddenElapsedSeconds: overridden.timelineSeconds[index] + offset,
      nominalSecondsPerActualSecond: 1,
    }
  }

  const nominalMotion = nominal.segmentSeconds[index]
  const overriddenMotion = overridden.segmentSeconds[index]
  const motionElapsed = offset - nominalDelay
  if (nominalMotion <= 1e-9 || overriddenMotion <= 1e-9) {
    return {
      overriddenElapsedSeconds: overridden.timelineSeconds[index] + overridden.delayBeforeSegmentSeconds[index],
      nominalSecondsPerActualSecond: 1,
    }
  }

  return {
    overriddenElapsedSeconds: overridden.timelineSeconds[index]
      + overridden.delayBeforeSegmentSeconds[index]
      + motionElapsed * overriddenMotion / nominalMotion,
    nominalSecondsPerActualSecond: nominalMotion / overriddenMotion,
  }
}

export function useJobRuntimeEstimate(
  status: MachineStatus,
  model: GCodeModel | null,
  controllerSettings: ControllerSettings,
  loadedPath: string | null,
  fileName: string | null,
  localJob?: LocalJobRuntimeContext,
): JobRuntimeEstimate {
  const controllerJobActive = status.state === 'Run' || status.state === 'Hold'
  const localJobActive = localJob?.active === true
  const isJobActive = controllerJobActive || localJobActive
  const matchesJob = !!model && (localJobActive || (controllerJobActive && fileMatchesJob(status, loadedPath, fileName)))
  const jobKey = matchesJob
    ? localJobActive
      ? `local|${localJob.key}`
      : status.sdFilename ? `${status.sdFilename}|${loadedPath ?? ''}|${fileName ?? ''}` : null
    : null

  // Wall-time tracking
  const activeRunStartedAtRef = useRef<number | null>(null)
  const accumulatedRunMsRef = useRef(0)
  const activeJobKeyRef = useRef<string | null>(null)

  const nominalCompletedSecRef = useRef(0)
  const lastSampleMsRef = useRef<number | null>(null)
  const lastSampleScaleRef = useRef(1)

  const [clockNowMs, setClockNowMs] = useState(() => Date.now())

  const timingEstimate = useMemo(
    () => (matchesJob && model ? buildJobTimingEstimate(model, controllerSettings) : null),
    [matchesJob, model, controllerSettings],
  )

  const overriddenTimingEstimate = useMemo(
    () => (matchesJob && model ? buildJobTimingEstimate(model, controllerSettings, {
      feedPercent: status.feedOverride,
      rapidPercent: status.rapidOverride,
    }) : null),
    [matchesJob, model, controllerSettings, status.feedOverride, status.rapidOverride],
  )

  const scaleAtNominalTime = (nominalElapsedSeconds: number) => {
    if (!timingEstimate || timingEstimate.totalSeconds <= 0
      || !overriddenTimingEstimate || overriddenTimingEstimate.totalSeconds <= 0) {
      return getOverrideScale(status.feedOverride)
    }
    return getTimelinePosition(timingEstimate, overriddenTimingEstimate, nominalElapsedSeconds)
      .nominalSecondsPerActualSecond
  }

  const integrateUpTo = (nowMs: number) => {
    if (lastSampleMsRef.current === null) {
      lastSampleMsRef.current = nowMs
      return
    }
    const dtMs = nowMs - lastSampleMsRef.current
    if (dtMs > 0) {
      nominalCompletedSecRef.current += (dtMs / 1000) * lastSampleScaleRef.current
    }
    lastSampleMsRef.current = nowMs
  }

  useEffect(() => {
    if (!jobKey) {
      activeRunStartedAtRef.current = null
      accumulatedRunMsRef.current = 0
      activeJobKeyRef.current = null
      nominalCompletedSecRef.current = 0
      lastSampleMsRef.current = null
      lastSampleScaleRef.current = 1
      return
    }

    const now = Date.now()
    if (activeJobKeyRef.current !== jobKey) {
      activeJobKeyRef.current = jobKey
      accumulatedRunMsRef.current = 0
      nominalCompletedSecRef.current = 0
      activeRunStartedAtRef.current = status.state === 'Run' ? now : null
      lastSampleMsRef.current = status.state === 'Run' ? now : null
      lastSampleScaleRef.current = scaleAtNominalTime(0)
      return
    }

    if (status.state === 'Run') {
      if (activeRunStartedAtRef.current === null) {
        activeRunStartedAtRef.current = now
        lastSampleMsRef.current = now
        lastSampleScaleRef.current = scaleAtNominalTime(nominalCompletedSecRef.current)
      } else {
        // Integrate using the previous override first, then use the new one
        // from this exact point in the job onward.
        integrateUpTo(now)
        lastSampleScaleRef.current = scaleAtNominalTime(nominalCompletedSecRef.current)
      }
    } else if (activeRunStartedAtRef.current !== null) {

      accumulatedRunMsRef.current += now - activeRunStartedAtRef.current
      integrateUpTo(now)
      activeRunStartedAtRef.current = null
      lastSampleMsRef.current = null
    }
  }, [jobKey, status.state, timingEstimate, overriddenTimingEstimate, status.feedOverride, status.rapidOverride])

  useEffect(() => {
    if (!jobKey || status.state !== 'Run') return

    const timer = window.setInterval(() => {
      const now = Date.now()
      integrateUpTo(now)
      lastSampleScaleRef.current = scaleAtNominalTime(nominalCompletedSecRef.current)
      setClockNowMs(now)
    }, 250)

    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey, status.state, timingEstimate, overriddenTimingEstimate, status.feedOverride, status.rapidOverride])

  if (!isJobActive) {
    return { source: 'none', progressPercent: null, elapsedSeconds: null, remainingSeconds: null, totalSeconds: null }
  }

  if (!timingEstimate) {
    if (localJobActive) {
      return { source: 'none', progressPercent: null, elapsedSeconds: null, remainingSeconds: null, totalSeconds: null }
    }
    return {
      source: 'sd',
      progressPercent: status.sdPercent ?? 0,
      elapsedSeconds: null,
      remainingSeconds: null,
      totalSeconds: null,
    }
  }

  const elapsedRunMs = accumulatedRunMsRef.current + (
    activeRunStartedAtRef.current !== null ? Math.max(0, clockNowMs - activeRunStartedAtRef.current) : 0
  )
  const elapsedSeconds = elapsedRunMs / 1000

  const sinceLastSampleMs = (lastSampleMsRef.current !== null && status.state === 'Run')
    ? Math.max(0, clockNowMs - lastSampleMsRef.current)
    : 0
  const nominalCompletedSec = nominalCompletedSecRef.current
    + (sinceLastSampleMs / 1000) * lastSampleScaleRef.current
  const timelinePosition = overriddenTimingEstimate
    ? getTimelinePosition(timingEstimate, overriddenTimingEstimate, nominalCompletedSec)
    : { overriddenElapsedSeconds: nominalCompletedSec, nominalSecondsPerActualSecond: 1 }
  const remainingSeconds = Math.max(0, (overriddenTimingEstimate?.totalSeconds ?? timingEstimate.totalSeconds)
    - timelinePosition.overriddenElapsedSeconds)
  const totalSeconds = elapsedSeconds + remainingSeconds

  const progressPercent = timingEstimate.totalSeconds > 0
    ? clamp01(nominalCompletedSec / timingEstimate.totalSeconds) * 100
    : 0

  return {
    source: 'estimated',
    progressPercent,
    elapsedSeconds,
    remainingSeconds,
    totalSeconds,
  }
}
