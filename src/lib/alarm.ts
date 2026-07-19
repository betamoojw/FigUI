import { sendRaw, sendRealtime } from './ws'

const CRITICAL_ALARMS = new Set([1, 2, 13, 16])

export function alarmRequiresSoftReset(alarmCode: number | undefined) {
  return alarmCode != null && CRITICAL_ALARMS.has(alarmCode)
}

export function alarmClearActionTitle(alarmCode: number | undefined) {
  return alarmRequiresSoftReset(alarmCode)
    ? 'Click to clear critical alarm (soft reset)'
    : 'Click to clear alarm ($X)'
}

export function clearMachineAlarm(alarmCode: number | undefined) {
  if (alarmRequiresSoftReset(alarmCode)) {
    if (!confirm('This alarm requires a soft reset to clear. Continue?')) return
    sendRealtime(0x18)
    return
  }

  sendRaw('$X')
}
