import { Play, Pause, Square, RotateCcw, DoorOpen } from 'lucide-react'
import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { formatRuntime, useJobRuntimeEstimate } from '../lib/jobRuntime'
import { sendRealtime } from '../lib/ws'
import { clearMachineAlarm } from '../lib/alarm'

export function JobControl() {
  const status = useMachineStore(s => s.status)
  const controllerSettings = useMachineStore(s => s.controllerSettings)
  const model = useGCodeStore(s => s.model)
  const loadedPath = useGCodeStore(s => s.loadedPath)
  const fileName = useGCodeStore(s => s.fileName)
  const { state, sdFilename } = status
  const runtime = useJobRuntimeEstimate(status, model, controllerSettings, loadedPath, fileName)
  const progressPercent = runtime.progressPercent
  const cancelTrackedJob = useGCodeStore(s => s.cancelTrackedJob)

  const isRunning = state === 'Run'
  const isHold    = state === 'Hold'
  const isAlarm   = state === 'Alarm'
  const isDoor    = state === 'Door'
  const hasSd     = Boolean(sdFilename)

  function resume()     { sendRealtime(0x7E) }
  function pause()      { sendRealtime(0x21) }
  function softReset()  {
    if (!confirm('Abort job and reset?')) return
    cancelTrackedJob('controller')
    sendRealtime(0x18)
  }
  function clearAlarm() { clearMachineAlarm(status.alarmCode) }

  if (!hasSd && !isAlarm && !isHold && !isDoor) return null

  return (
    <div className="panel">
      <div className="panel-header">Job Control</div>
      <div className="p-4 space-y-3">

        {/* SD progress */}
        {hasSd && (
          <div className="space-y-1.5">
            <div className="text-sm text-text-muted font-mono truncate">{sdFilename}</div>
            {progressPercent != null && (
              <div className="w-full h-1.5 bg-elevated rounded-full overflow-hidden">
                <div
                  className="h-full bg-info transition-all duration-500 rounded-full"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
            {runtime.source === 'estimated' && (
              <div className="flex justify-between text-xs font-mono text-text-muted tabular-nums">
                <span>Elapsed {formatRuntime(runtime.elapsedSeconds)}</span>
                <span>Remain {formatRuntime(runtime.remainingSeconds)}</span>
                <span>Total {formatRuntime(runtime.totalSeconds)}</span>
              </div>
            )}
          </div>
        )}

        {/* Door state notice */}
        {isDoor && (
          <div className="flex items-center gap-2 px-3 py-2 rounded bg-warn/10
                          border border-warn/30 text-sm text-warn">
            <DoorOpen size={13} className="shrink-0" />
            <span>Door open — close door then resume</span>
          </div>
        )}

        {/* Alarm state notice */}
        {isAlarm && (
          <div className="px-3 py-2 rounded bg-danger/10 border border-danger/30
                          text-sm text-danger text-center">
            ALARM — check machine before unlocking
          </div>
        )}

        {/* Action buttons */}
        {isRunning ? (
          <div className="flex gap-2">
            <button className="btn btn-warn-solid gap-1.5 text-sm justify-center flex-1" onClick={pause}>
              <Pause size={13} />
              Hold
            </button>
            <button className="btn btn-danger-solid gap-1.5 text-sm justify-center flex-1" onClick={softReset}>
              <Square size={13} />
              Abort
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {(isHold || isDoor) ? (
              <button className="btn btn-ok-solid gap-1.5 text-sm justify-center flex-1" onClick={resume}>
                <Play size={13} />
                Resume
              </button>
            ) : (
              <button className="btn btn-warn-solid gap-1.5 text-sm justify-center flex-1" onClick={pause} disabled>
                <Pause size={13} />
                Hold
              </button>
            )}

            <button className="btn btn-danger-solid gap-1.5 text-sm justify-center flex-1" onClick={softReset}>
              <Square size={13} />
              Abort
            </button>

            {(isAlarm || isDoor) && (
              <button className="btn btn-ghost gap-1.5 text-sm justify-center flex-1" onClick={clearAlarm}>
                <RotateCcw size={13} />
                Unlock
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
