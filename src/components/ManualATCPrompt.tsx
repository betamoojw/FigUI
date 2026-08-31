import { useMachineStore } from '../store'
import { useManualAtcStore } from '../store/manualAtc'

export function ManualATCPrompt() {
  const enabled = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const machineState = useMachineStore(s => s.status.state)
  const phase = useManualAtcStore(s => s.phase)
  const requestedTool = useManualAtcStore(s => s.requestedTool)
  const resumeToolChange = useManualAtcStore(s => s.resumeToolChange)

  if (!enabled || (phase !== 'awaiting-tool' && phase !== 'resuming')) return null

  const ready = phase === 'awaiting-tool' && machineState === 'Hold'
  return <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center sm:p-4">
    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
    <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-lg border border-border bg-surface p-5 shadow-2xl">
      <h2 className="text-xl font-semibold text-text-primary">
        {requestedTool != null ? `Install Tool T${requestedTool}` : 'Change Tool'}
      </h2>
      <p className="mt-2 text-text-muted">Install the next tool and continue when ready.</p>
      <button className="btn btn-ok-solid mt-5 h-12 w-full justify-center text-lg" disabled={!ready} onClick={resumeToolChange}>
        {phase === 'resuming' ? 'Proceeding…' : machineState === 'Door' ? 'Close Door' : ready ? 'Ready' : 'Moving to Change Position…'}
      </button>
    </div>
  </div>
}
