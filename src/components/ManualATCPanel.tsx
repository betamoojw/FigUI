import { useMachineStore } from '../store'
import { useManualAtcStore } from '../store/manualAtc'

export function ManualATCPanel({ isTablet, embedded = false }: { isTablet?: boolean; embedded?: boolean }) {
  const connected = useMachineStore(s => s.connected)
  const status = useMachineStore(s => s.status)
  const settings = useMachineStore(s => s.controllerSettings)
  const resetReference = useManualAtcStore(s => s.resetReference)
  const requestToolChange = useManualAtcStore(s => s.requestToolChange)

  if (settings.hasManualATC !== true) return null

  const idle = connected && status.state === 'Idle'
  const currentTool = status.gcodeModes?.tool
  const xyPlane = status.gcodeModes?.plane == null || status.gcodeModes.plane === 'G17'
  const buttonClass = `btn w-full justify-center ${isTablet ? 'h-16 text-xl' : 'h-11 text-base'}`

  return <div className={embedded ? '' : 'panel'}>
    <div className="panel-header justify-between">
      <span>Manual Tool Change</span>
      {currentTool != null && currentTool > 0 && <span className="text-text-muted">Tool T{currentTool}</span>}
    </div>
    <div className="grid grid-cols-2 gap-2 p-3">
      <button
        className={`${buttonClass} btn-ghost`}
        disabled={!idle}
        title="Use before manually setting Z zero on a new workpiece"
        onClick={resetReference}
      >
        Reset Tool Reference
      </button>
      <button
        className={`${buttonClass} btn-warn`}
        disabled={!idle || !xyPlane}
        title={!xyPlane ? 'Manual tool change requires G17' : undefined}
        onClick={requestToolChange}
      >
        Change Tool
      </button>
    </div>
  </div>
}
