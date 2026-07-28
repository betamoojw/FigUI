import { create } from 'zustand'
import {
  parseGCode,
  type GCodeModel,
  type ParseGCodeOptions,
  type WorkCoordinateSystem,
  type WorkOffset,
} from '../lib/gcode'
import { useMachineStore } from '../store'
import { getBase, sendCommand } from '../lib/http'
import { MM_PER_INCH } from '../lib/units'
import { sendRaw } from '../lib/ws'
import {
  buildStatic2DPathsAsync,
  buildStatic3DGeometryAsync,
  nextAnimationFrame,
  type Built2DPaths,
  type Built3DGeometry,
} from '../lib/gcodeBuild'

export interface Geometry3D extends Built3DGeometry {
  showRapids: boolean
}

type TrackedJobSource = 'local' | 'controller'

interface GCodeStore {
  // Identity
  loadedPath: string | null
  fileName: string | null
  sourceText: string | null
  restartSource: {
    path: string | null
    fileName: string
    sourceText?: string
    requestedLine: number
    resumeLine: number
  } | null
  activeSourceLine: number | null

  // Built data (shared across all GCodeViewer instances — one parse, one build)
  model: GCodeModel | null
  paths2D: Built2DPaths | null
  geometry3D: Geometry3D | null

  // Setting (shared so 3D rebuild only happens once on toggle)
  showRapids: boolean

  // Loading state
  loading: boolean
  pendingPath: string | null
  downloadProgress: number | null
  isProcessing2D: boolean
  processing2DProgress: number
  isProcessing3D: boolean
  processing3DProgress: number
  is3DReady: boolean

  // Job completion feedback
  trackedJob: { source: TrackedJobSource; startedAt: number } | null
  finishedJobElapsedMs: number | null

  // Actions
  loadFile: (path: string) => Promise<void>
  loadFromText: (
    text: string,
    name: string,
    path?: string | null,
    restartSource?: GCodeStore['restartSource'],
  ) => Promise<void>
  cancelAndStartJob: (path: string) => boolean
  startTrackedJob: (source: TrackedJobSource) => void
  finishTrackedJob: (source: TrackedJobSource) => void
  cancelTrackedJob: (source?: TrackedJobSource) => void
  dismissFinishedJobNotice: () => void
  setShowRapids: (v: boolean) => void
  setActiveSourceLine: (line: number | null) => void
  clear: () => void
}


let activeLoadPath: string | null = null
let loadRequestId = 0
let abortController: AbortController | null = null
let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null

const WORK_COORDINATE_SYSTEMS = new Set<WorkCoordinateSystem>([
  'G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3',
])

function isLoadBlockedByMachineState() {
  const machine = useMachineStore.getState()
  const state = machine.status.state
  return machine.connected && (state === 'Run' || state === 'Hold')
}

function abortInFlight() {
  ++loadRequestId
  if (activeReader) {
    activeReader.cancel().catch(() => {})
    activeReader = null
  }
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  activeLoadPath = null
}

function normalizeWcs(value: string | undefined): WorkCoordinateSystem | undefined {
  if (!value) return undefined
  const upper = value.toUpperCase()
  return WORK_COORDINATE_SYSTEMS.has(upper as WorkCoordinateSystem)
    ? upper as WorkCoordinateSystem
    : undefined
}

function parseWorkOffsetResponse(
  text: string,
  linearScale = 1,
): Partial<Record<WorkCoordinateSystem, WorkOffset>> {
  const offsets: Partial<Record<WorkCoordinateSystem, WorkOffset>> = {}
  const numberPattern = '(-?(?:\\d+\\.?\\d*|\\.\\d+))'
  const offsetPattern = new RegExp(`^\\[(G5[4-9](?:\\.[1-3])?):${numberPattern},${numberPattern},${numberPattern}(?:,[^\\]]*)?\\]$`)
  for (const raw of text.split('\n')) {
    const match = raw.trim().match(offsetPattern)
    const wcs = normalizeWcs(match?.[1])
    if (!match || !wcs) continue
    offsets[wcs] = {
      x: Number.parseFloat(match[2]) * linearScale,
      y: Number.parseFloat(match[3]) * linearScale,
      z: Number.parseFloat(match[4]) * linearScale,
    }
  }
  return offsets
}

async function getParseOptions(): Promise<ParseGCodeOptions> {
  const machine = useMachineStore.getState()
  const activeWcs = normalizeWcs(machine.status.gcodeModes?.wcs)
  const currentWco = machine.status.wco
  const workOffsets: Partial<Record<WorkCoordinateSystem, WorkOffset>> = {}

  if (activeWcs) {
    workOffsets[activeWcs] = currentWco
  }

  if (machine.connected) {
    try {
      const linearScale = machine.controllerSettings.reportInches ? MM_PER_INCH : 1
      Object.assign(workOffsets, parseWorkOffsetResponse(await sendCommand('$#'), linearScale))
      if (activeWcs) {
        workOffsets[activeWcs] = currentWco
      }
    } catch (e) {
      console.warn('Failed to fetch work offsets for G-code preview:', e)
    }
  }

  return { activeWcs, currentWco, workOffsets }
}

export const useGCodeStore = create<GCodeStore>((set, get) => ({
  loadedPath: null,
  fileName: null,
  sourceText: null,
  restartSource: null,
  activeSourceLine: null,
  model: null,
  paths2D: null,
  geometry3D: null,
  showRapids: true,
  loading: false,
  pendingPath: null,
  downloadProgress: null,
  isProcessing2D: false,
  processing2DProgress: 0,
  isProcessing3D: false,
  processing3DProgress: 0,
  is3DReady: false,
  trackedJob: null,
  finishedJobElapsedMs: null,

  loadFile: async (path: string) => {
    if (isLoadBlockedByMachineState()) return
    if (activeLoadPath === path) return

    set({ finishedJobElapsedMs: null })
    abortInFlight()
    activeLoadPath = path
    const requestId = ++loadRequestId

    set({
      loading: true,
      pendingPath: path,
      downloadProgress: 0,
      isProcessing2D: false,
      processing2DProgress: 0,
      isProcessing3D: false,
      processing3DProgress: 0,
      is3DReady: false,
      geometry3D: null,
      paths2D: null,
      activeSourceLine: null,
    })

    try {
      const url = `${getBase()}${path}`
      abortController = new AbortController()
      const res = await fetch(url, { signal: abortController.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const contentLength = Number(res.headers.get('content-length') ?? '0')
      let text = ''

      if (res.body) {
        const reader = res.body.getReader()
        activeReader = reader
        const decoder = new TextDecoder()
        const chunks: string[] = []
        let received = 0
        let lastProgress = -1

        while (true) {
          const { done, value } = await reader.read()
          if (requestId !== loadRequestId) { reader.cancel().catch(() => {}); return }
          if (done) break
          if (!value) continue

          received += value.byteLength
          chunks.push(decoder.decode(value, { stream: true }))

          if (contentLength > 0) {
            const progress = Math.min(100, Math.round((received / contentLength) * 100))
            if (progress !== lastProgress) {
              lastProgress = progress
              set({ downloadProgress: progress })
            }
          }
        }

        chunks.push(decoder.decode())
        text = chunks.join('')
        activeReader = null
      } else {
        text = await res.text()
      }

      if (requestId !== loadRequestId) return
      set({ downloadProgress: 100, isProcessing2D: true, processing2DProgress: 5 })
      await nextAnimationFrame()

      const parseOptions = await getParseOptions()
      if (requestId !== loadRequestId) return

      const parsed = parseGCode(text, parseOptions)
      if (requestId !== loadRequestId) return
      set({ processing2DProgress: 15 })

      const built2DPaths = await buildStatic2DPathsAsync(
        parsed.segments,
        progress => {
          if (requestId === loadRequestId) {
            set({ processing2DProgress: Math.max(15, progress) })
          }
        },
        () => requestId === loadRequestId,
      )
      if (requestId !== loadRequestId) return

      const fileName = path.split('/').pop() ?? path
      set({
        model: parsed,
        paths2D: built2DPaths,
        fileName,
        loadedPath: path,
        sourceText: text,
        restartSource: null,
        processing2DProgress: 100,
        isProcessing2D: false,
        loading: false,
        pendingPath: null,
        isProcessing3D: true,
        processing3DProgress: 0,
      })

      const showRapids = get().showRapids
      const built3DGeometry = await buildStatic3DGeometryAsync(
        parsed.segments,
        showRapids,
        progress => {
          if (requestId === loadRequestId) {
            set({ processing3DProgress: progress })
          }
        },
        () => requestId === loadRequestId,
      )
      if (requestId !== loadRequestId) return

      set({
        geometry3D: { ...built3DGeometry, showRapids },
        processing3DProgress: 100,
        isProcessing3D: false,
        is3DReady: true,
      })
    } catch (e) {
      if (requestId === loadRequestId && (!(e instanceof Error) || e.message !== 'stale-load')) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          console.error('Failed to load G-code:', e)
        }
      }
    } finally {
      if (requestId === loadRequestId) {
        activeLoadPath = null
        abortController = null
        activeReader = null
        set({
          loading: false,
          pendingPath: null,
          isProcessing2D: false,
          isProcessing3D: false,
          is3DReady: get().geometry3D !== null,
        })
      }
    }
  },

  loadFromText: async (text: string, name: string, path = null, restartSource = null) => {
    if (isLoadBlockedByMachineState()) return
    set({ finishedJobElapsedMs: null })
    abortInFlight()
    const requestId = ++loadRequestId

    set({
      loading: true,
      pendingPath: null,
      downloadProgress: 100,
      isProcessing2D: true,
      processing2DProgress: 5,
      isProcessing3D: false,
      processing3DProgress: 0,
      is3DReady: false,
      geometry3D: null,
      paths2D: null,
      activeSourceLine: null,
    })

    try {
      await nextAnimationFrame()
      const parseOptions = await getParseOptions()
      if (requestId !== loadRequestId) return

      const parsed = parseGCode(text, parseOptions)
      if (requestId !== loadRequestId) return
      set({ processing2DProgress: 15 })

      const built2DPaths = await buildStatic2DPathsAsync(
        parsed.segments,
        progress => {
          if (requestId === loadRequestId) {
            set({ processing2DProgress: Math.max(15, progress) })
          }
        },
        () => requestId === loadRequestId,
      )
      if (requestId !== loadRequestId) return

      set({
        model: parsed,
        paths2D: built2DPaths,
        fileName: name,
        loadedPath: path,
        sourceText: text,
        restartSource,
        processing2DProgress: 100,
        isProcessing2D: false,
        loading: false,
        isProcessing3D: true,
        processing3DProgress: 0,
      })

      const showRapids = get().showRapids
      const built3DGeometry = await buildStatic3DGeometryAsync(
        parsed.segments,
        showRapids,
        progress => {
          if (requestId === loadRequestId) set({ processing3DProgress: progress })
        },
        () => requestId === loadRequestId,
      )
      if (requestId !== loadRequestId) return

      set({
        geometry3D: { ...built3DGeometry, showRapids },
        processing3DProgress: 100,
        isProcessing3D: false,
        is3DReady: true,
      })
    } catch (e) {
      if (requestId === loadRequestId && (!(e instanceof Error) || e.message !== 'stale-load')) {
        console.error('Failed to load G-code from text:', e)
      }
    } finally {
      if (requestId === loadRequestId) {
        set({
          loading: false,
          isProcessing2D: false,
          isProcessing3D: false,
          is3DReady: get().geometry3D !== null,
        })
      }
    }
  },

  cancelAndStartJob: (path: string) => {
    // Stop any in-flight download immediately. The ESP32 must not be serving a
    set({ finishedJobElapsedMs: null })
    abortInFlight()
    set({
      loading: false,
      pendingPath: null,
      isProcessing2D: false,
      isProcessing3D: false,
      downloadProgress: null,
      // Mark this path as the loaded one so the SD-job-start auto-load doesn't
      // re-fetch it. The user explicitly chose to skip the preview.
      loadedPath: path,
      fileName: path.split('/').pop() ?? path,
      sourceText: null,
      restartSource: null,
      activeSourceLine: null,
      // Drop any partial built data — they're stale now.
      model: null,
      paths2D: null,
      geometry3D: null,
      is3DReady: false,
    })
    return sendRaw(`$SD/Run=${path}`)
  },

  startTrackedJob: source => set({
    trackedJob: { source, startedAt: Date.now() },
    finishedJobElapsedMs: null,
  }),

  finishTrackedJob: source => {
    const trackedJob = get().trackedJob
    if (!trackedJob || trackedJob.source !== source) return
    set({
      trackedJob: null,
      finishedJobElapsedMs: Math.max(0, Date.now() - trackedJob.startedAt),
    })
  },

  cancelTrackedJob: source => {
    const trackedJob = get().trackedJob
    if (source && trackedJob?.source !== source) return
    set({ trackedJob: null })
  },

  dismissFinishedJobNotice: () => set({ finishedJobElapsedMs: null }),

  setShowRapids: (v: boolean) => {
    if (get().showRapids === v) return
    set({ showRapids: v })

    const model = get().model
    if (!model) return

    // 2D rendering filters at draw time, so only the 3D geometry needs rebuilding.
    set({ isProcessing3D: true, processing3DProgress: 0, is3DReady: false })
    const requestId = ++loadRequestId

    buildStatic3DGeometryAsync(
      model.segments,
      v,
      progress => {
        if (requestId === loadRequestId) set({ processing3DProgress: progress })
      },
      () => requestId === loadRequestId,
    ).then(geometry => {
      if (requestId !== loadRequestId) return
      set({
        geometry3D: { ...geometry, showRapids: v },
        processing3DProgress: 100,
        isProcessing3D: false,
        is3DReady: true,
      })
    }).catch(e => {
      if (requestId === loadRequestId && (!(e instanceof Error) || e.message !== 'stale-load')) {
        console.error('Failed to rebuild 3D geometry:', e)
      }
    })
  },

  setActiveSourceLine: (line: number | null) => {
    if (get().activeSourceLine === line) return
    set({ activeSourceLine: line })
  },

  clear: () => {
    abortInFlight()
    set({
      loadedPath: null,
      fileName: null,
      sourceText: null,
      restartSource: null,
      activeSourceLine: null,
      model: null,
      paths2D: null,
      geometry3D: null,
      loading: false,
      pendingPath: null,
      downloadProgress: null,
      isProcessing2D: false,
      processing2DProgress: 0,
      isProcessing3D: false,
      processing3DProgress: 0,
      is3DReady: false,
    })
  },
}))
