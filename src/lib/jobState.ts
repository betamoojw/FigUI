import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'

/**
 * FluidNC reports Idle while it waits for a configured spindle spin-up delay.
 * Keep UI controls aligned with the job request during that interval.
 */
export function useControllerJobStarting() {
  const machineState = useMachineStore(s => s.status.state)
  const trackedJobSource = useGCodeStore(s => s.trackedJob?.source)
  return trackedJobSource === 'controller' && machineState === 'Idle'
}
