import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, FileCode2, Info, Navigation } from '../icons'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { ProbePanel } from './ProbePanel'
import { ManualATCPanel } from './ManualATCPanel'
import { useGCodeSenderStore } from '../store/gcodeSender'

const LINE_HEIGHT = 20
const PADDING_Y = 10

function basename(path: string | null | undefined) {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function normalizedJobPath(path: string | null | undefined) {
  if (!path) return ''
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:sd|localfs)\//i, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function pathsIdentifySameJob(runningPath: string, loadedPath: string) {
  const running = normalizedJobPath(runningPath)
  const loaded = normalizedJobPath(loadedPath)
  if (!running || !loaded) return false
  if (running.includes('/') && loaded.includes('/')) return running === loaded
  return basename(running) === basename(loaded)
}

function stripComments(raw: string) {
  let result = ''
  let depth = 0
  for (const char of raw) {
    if (char === ';' && depth === 0) break
    if (char === '(') { depth++; continue }
    if (char === ')' && depth > 0) { depth--; continue }
    if (depth === 0) result += char
  }
  return result
}

function plannerNumber(raw: string) {
  const match = stripComments(raw).match(/^\s*\/?\s*N\s*(\d+)/i)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

function buildProgram(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const nToPhysicalLine = new Map<number, number>()
  lines.forEach((line, index) => {
    const n = plannerNumber(line)
    if (n != null && !nToPhysicalLine.has(n)) nToPhysicalLine.set(n, index + 1)
  })
  return {
    text: normalized,
    totalLines: Math.max(1, lines.length),
    lineNumbers: Array.from({ length: Math.max(1, lines.length) }, (_, index) => String(index + 1)).join('\n'),
    nToPhysicalLine,
  }
}

export function ProgramExecutionPanel({ isTablet, initiallyOpen = false, accordionManaged = false }: { isTablet?: boolean; initiallyOpen?: boolean; accordionManaged?: boolean }) {
  const status = useMachineStore(s => s.status)
  const sourceText = useGCodeStore(s => s.sourceText)
  const fileName = useGCodeStore(s => s.fileName)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const viewerSourceLine = useGCodeStore(s => s.activeSourceLine)
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderAcceptedLine = useGCodeSenderStore(s => s.acceptedLine)
  const senderFailureLine = useGCodeSenderStore(s => s.failureLine)
  const senderFailureLineSource = useGCodeSenderStore(s => s.failureLineSource)
  const programRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(initiallyOpen)
  const contentOpen = accordionManaged || open
  const [follow, setFollow] = useState(true)
  const [showTrackingInfo, setShowTrackingInfo] = useState(false)

  const runningName = basename(status.sdFilename)
  const loadedName = basename(loadedPath) || fileName || ''
  const sourceMatchesJob = !!sourceText && (
    !status.sdFilename
    || (loadedPath
      ? pathsIdentifySameJob(status.sdFilename, loadedPath)
      : runningName.toLowerCase() === loadedName.toLowerCase())
  )
  const program = useMemo(() => buildProgram(sourceMatchesJob ? sourceText! : ''), [sourceMatchesJob, sourceText])
  const reportedN = status.plannerLineNumber
  const senderActive = senderPhase === 'streaming' || senderPhase === 'paused' || senderPhase === 'draining'
  const senderMode = senderPhase !== 'idle'
  const controllerPhysicalLine = reportedN == null ? null : program.nToPhysicalLine.get(reportedN) ?? null
  const estimatedPhysicalLine = sourceMatchesJob
    && viewerSourceLine != null
    && viewerSourceLine >= 1
    && viewerSourceLine <= program.totalLines
    ? viewerSourceLine
    : null
  const retainedFailureLine = senderMode && !senderActive && senderFailureLineSource === 'position'
    ? senderFailureLine
    : null
  const physicalLine = retainedFailureLine ?? controllerPhysicalLine ?? estimatedPhysicalLine
  const isEstimated = retainedFailureLine != null || (controllerPhysicalLine == null && estimatedPhysicalLine != null)

  function updateHighlight(scrollTop = programRef.current?.scrollTop ?? 0) {
    const highlight = highlightRef.current
    if (!highlight) return
    if (physicalLine == null) {
      highlight.style.display = 'none'
      return
    }
    highlight.style.display = 'block'
    highlight.style.transform = `translateY(${PADDING_Y + (physicalLine - 1) * LINE_HEIGHT - scrollTop}px)`
  }

  useEffect(() => {
    const editor = programRef.current
    if (!editor || physicalLine == null) {
      updateHighlight()
      return
    }
    if (follow) {
      editor.scrollTop = Math.max(0, (physicalLine - 1) * LINE_HEIGHT - editor.clientHeight / 2 + LINE_HEIGHT / 2)
      if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop
    }
    updateHighlight(editor.scrollTop)
  }, [physicalLine, follow])

  const trackingMessage = !sourceMatchesJob
    ? runningName
      ? `The running file ${runningName} is not loaded in the viewer.`
      : 'Program source is unavailable because this job was started without loading its preview.'
    : reportedN != null && controllerPhysicalLine == null && estimatedPhysicalLine == null
        ? `FluidNC reports N${reportedN}, but that block is not present in the loaded file.`
        : physicalLine == null
          ? senderActive && senderAcceptedLine != null
            ? `FluidNC has accepted through file line ${senderAcceptedLine}; waiting to locate the executing motion from live XYZ.`
            : 'Waiting for the viewer to locate the tool on the loaded toolpath.'
          : null

  return (
    <div className={`${accordionManaged ? 'flex-1 min-h-0' : 'panel shrink-0'} flex flex-col overflow-hidden ${contentOpen && !accordionManaged ? (isTablet ? 'h-[360px]' : 'h-[280px]') : ''}`}>
      {!accordionManaged && <div className="panel-header justify-between shrink-0">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(value => !value)}
          aria-expanded={contentOpen}
        >
          <FileCode2 size={isTablet ? 20 : 15} className="text-accent shrink-0" />
          <span className={`${isTablet ? 'text-xl' : 'text-lg'} font-semibold shrink-0`}>Program Execution</span>
          <ChevronDown size={isTablet ? 20 : 15} className={`ml-auto shrink-0 transition-transform duration-200 ${contentOpen ? 'rotate-180' : ''}`} />
        </button>
        {contentOpen && <div className="ml-2 flex items-center gap-2 shrink-0">
          <div className="relative">
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-text-dim transition-colors hover:bg-elevated hover:text-info"
              onClick={() => setShowTrackingInfo(value => !value)}
              aria-label={senderMode ? 'About local sender line tracking' : 'About program line tracking'}
              aria-expanded={showTrackingInfo}
            >
              <Info size={14} />
            </button>
            {showTrackingInfo && (
              <div role="note" className="absolute right-0 top-9 z-50 w-72 rounded border border-border bg-surface p-3 text-xs font-normal normal-case tracking-normal text-text-muted shadow-xl">
                <p className="font-semibold text-text-primary">
                  {senderMode ? 'Local job line tracking' : 'About line tracking'}
                </p>
                {senderMode ? (
                  <p className="mt-1.5">
                    This is an approximation of the current line being executed. It may differ slightly due to FluidNC's planner queue.
                  </p>
                ) : (
                  <>
                    <p className="mt-1.5">
                      When FluidNC reports an N block, that value is mapped directly to the loaded controller file. Otherwise, FigUI estimates the nearest motion line from live XYZ position.
                    </p>
                    <p className="mt-1.5">
                      The estimate cannot identify non-motion commands such as dwells, pauses, tool changes, spindle commands, or modal-only lines because they do not change the reported coordinates. Treat it as a visual aid, not an exact execution or restart position.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          {senderMode ? (
            physicalLine != null ? (
              <span className={`tag normal-case font-mono tracking-normal ${isEstimated ? 'border-info/35 bg-info/10 text-info' : 'border-ok/35 bg-ok/10 text-ok'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isEstimated ? 'bg-info' : 'bg-ok'} ${senderActive ? 'animate-pulse' : ''}`} />
                Line {physicalLine}
              </span>
            ) : (
              <span className="text-xs font-mono text-text-dim">Locating…</span>
            )
          ) : controllerPhysicalLine != null && reportedN != null ? (
            <span className="tag border-ok/35 bg-ok/10 text-ok normal-case font-mono tracking-normal">
              <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
              N{reportedN}
            </span>
          ) : isEstimated ? (
            <span className="tag border-info/35 bg-info/10 text-info normal-case font-mono tracking-normal" title="Nearest motion line estimated from the viewer's live XYZ toolpath tracker">
              ≈ Motion line {physicalLine}
            </span>
          ) : (
            <span className="text-xs font-mono text-text-dim">Locating…</span>
          )}
          {!senderMode && controllerPhysicalLine != null && (
            <span className="text-xs font-mono text-text-muted">File line {physicalLine}</span>
          )}
          <button
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${follow ? 'text-info bg-info/10' : 'text-text-dim hover:text-text-primary bg-elevated'}`}
            onClick={() => setFollow(value => !value)}
            title={follow ? 'Disable automatic line following' : 'Follow the executing line'}
          >
            <Navigation size={12} /> Follow
          </button>
        </div>}
      </div>}

      {contentOpen && (sourceMatchesJob ? (
        <div className="relative flex-1 min-h-0 overflow-hidden bg-surface font-mono text-[13px]">
          <div
            ref={highlightRef}
            className={`absolute left-0 right-0 h-5 pointer-events-none z-20 ${isEstimated ? 'bg-info/15 border-l-2 border-info' : 'bg-ok/15 border-l-2 border-ok'}`}
            style={{ display: physicalLine == null ? 'none' : 'block' }}
          />
          <div ref={gutterRef} className="absolute inset-y-0 left-0 w-16 overflow-hidden border-r border-border bg-elevated z-10 select-none" aria-hidden="true">
            <pre className="m-0 pr-3 text-right text-text-dim" style={{ paddingTop: PADDING_Y, paddingBottom: PADDING_Y, lineHeight: `${LINE_HEIGHT}px` }}>{program.lineNumbers}</pre>
          </div>
          <textarea
            ref={programRef}
            readOnly
            wrap="off"
            spellCheck={false}
            value={program.text}
            aria-label="Running G-code program"
            className="absolute inset-y-0 left-16 right-0 w-auto resize-none overflow-auto border-0 bg-transparent px-3 text-text-primary outline-none z-10 selection:bg-info/25"
            style={{ paddingTop: PADDING_Y, paddingBottom: PADDING_Y, lineHeight: `${LINE_HEIGHT}px`, tabSize: 2 }}
            onScroll={event => {
              const scrollTop = event.currentTarget.scrollTop
              if (gutterRef.current) gutterRef.current.scrollTop = scrollTop
              updateHighlight(scrollTop)
            }}
          />
          {trackingMessage && (
            <div className="absolute left-20 right-4 bottom-3 z-30 flex items-center gap-2 rounded border border-warn bg-surface px-3 py-2 text-xs text-warn shadow-lg pointer-events-none">
              <AlertTriangle size={13} className="shrink-0" />
              <span>{trackingMessage}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center p-5 bg-elevated/30">
          <div className="max-w-md text-center">
            <FileCode2 size={24} className="mx-auto mb-2 text-text-dim" />
            <p className={`${isTablet ? 'text-lg' : 'text-sm'} text-text-muted`}>{trackingMessage}</p>
            {reportedN != null && <p className="mt-2 font-mono text-ok">FluidNC executing N{reportedN}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Occupies the normal probing slot with live program tracking during a job. */
export function ProbeOrProgramPanel({ isTablet }: { isTablet?: boolean }) {
  const status = useMachineStore(s => s.status)
  const reportedHasProbe = useMachineStore(s => s.controllerSettings.hasProbe)
  const reportedHasToolsetter = useMachineStore(s => s.controllerSettings.hasToolsetter)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const hasProbingInput = reportedHasProbe || reportedHasToolsetter
  const senderPhase = useGCodeSenderStore(s => s.phase)
  const senderActive = senderPhase === 'streaming' || senderPhase === 'paused' || senderPhase === 'draining'
  const isProgramRunning = (status.state === 'Run' || status.state === 'Hold')
    && (!!status.sdFilename || status.plannerLineNumber != null)
  if (isProgramRunning || senderActive) return <ProgramExecutionPanel isTablet={isTablet} />
  return <>
    {hasManualATC && <ManualATCPanel isTablet={isTablet} />}
    {hasProbingInput && <ProbePanel isTablet={isTablet} />}
  </>
}
