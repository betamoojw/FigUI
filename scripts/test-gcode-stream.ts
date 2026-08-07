import assert from 'node:assert/strict'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message)
    await delay(10)
  }
}

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

class TestDocument extends EventTarget {
  visibilityState = 'visible'
  documentElement = { classList: { add() {}, remove() {} } }
}

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set()
    peers.add(this)
    FakeBroadcastChannel.channels.set(name, peers)
  }

  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data })
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

const testDocument = new TestDocument()
Object.assign(globalThis, {
  document: testDocument,
  window: Object.assign(new EventTarget(), { BroadcastChannel: FakeBroadcastChannel }),
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
})
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instance: FakeWebSocket | null = null

  readyState = FakeWebSocket.CONNECTING
  bufferedAmount = 0
  binaryType = ''
  sent: Array<string | Uint8Array> = []
  machineState = 'Idle'
  reportInterval = 750
  supportsReportInterval = true
  url = ''
  onopen: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null

  constructor(url: string, _protocol: string) {
    this.url = url
    FakeWebSocket.instance = this
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
      this.receive('CURRENT_ID:42')
    })
  }

  send(data: string | Uint8Array) {
    assert.equal(this.readyState, FakeWebSocket.OPEN)
    const copy = typeof data === 'string' ? data : new Uint8Array(data)
    this.sent.push(copy)
    if (copy instanceof Uint8Array && copy.length === 1 && copy[0] === 0x3f) {
      queueMicrotask(() => this.receive(`<${this.machineState}|WPos:0,0,0|MPos:0,0,0|FS:0,0>\n`))
      return
    }
    const text = typeof copy === 'string' ? copy : new TextDecoder().decode(copy)
    if (text.trim() === '$G') {
      queueMicrotask(() => this.receive('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\nok\n'))
    } else if (text.trim() === '$RI') {
      queueMicrotask(() => this.receive(this.supportsReportInterval
        ? `[MSG:INFO: websocket auto report interval is ${this.reportInterval} ms]\nok\n`
        : 'error:3\n'))
    } else if (/^\$RI=\d+$/.test(text.trim())) {
      this.reportInterval = Number(text.trim().slice(4))
      queueMicrotask(() => this.receive('ok\n'))
    } else if (text.startsWith('PING:')) {
      queueMicrotask(() => this.receive('PING:60000:60000'))
    }
  }

  receive(data: string) {
    this.onmessage?.({ data })
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }
}

Object.assign(globalThis, { WebSocket: FakeWebSocket })

const ws = await import('../src/lib/ws')
const { useMachineStore } = await import('../src/store')
const { useGCodeSenderStore } = await import('../src/store/gcodeSender')

await ws.connect('fluidnc.test')
const socket = FakeWebSocket.instance!
assert.equal(
  new URL(socket.url).searchParams.get('independent_session'),
  '1',
  'websocket must opt into a per-tab FluidNC session',
)
let sessionTakeovers = 0
const stopWatchingTakeovers = ws.onSessionTaken(() => { sessionTakeovers++ })
const secondTab = new FakeBroadcastChannel('fluidui-tab-coordination-v1')
secondTab.postMessage('tab-active')
assert.equal(sessionTakeovers, 1, 'a newly active browser tab must preserve FluidNC session-takeover signaling')
stopWatchingTakeovers()
secondTab.close()
useMachineStore.getState().updateStatus({ state: 'Idle' })
await delay(300)

const commands = Array.from({ length: 30 }, (_, index) => `G1 X${index} F100`).concat('M30')
socket.bufferedAmount = 2048
assert.equal(useGCodeSenderStore.getState().start(commands.join('\n'), 'window.gcode'), true)
assert.equal(ws.sendRaw('M9'), false, 'normal commands must be rejected while the stream owns ok responses')
useGCodeSenderStore.getState().pause()
assert.equal(useGCodeSenderStore.getState().phase, 'streaming', 'preparation cannot be stranded in Paused')
await delay(350)

const programMessages = () => socket.sent
  .filter((item): item is string => typeof item === 'string')
  .flatMap(item => item.split('\n').map(line => line.trim()).filter(Boolean))
  .filter(item => item.startsWith('G1 ') || item === 'M30')

const programFrames = () => socket.sent
  .filter((item): item is string => typeof item === 'string')
  .filter(item => item.split('\n').some(line => line.trim().startsWith('G1 ') || line.trim() === 'M30'))

assert.equal(programMessages().length, 0, 'stream must honor browser websocket backpressure')
socket.bufferedAmount = 0
socket.machineState = 'Run'
useMachineStore.getState().updateStatus({ state: 'Run' })
await waitFor(() => programMessages().length > 0, 'stream did not start after backpressure cleared')
assert.ok(
  programFrames().length > 0,
  'program commands must use websocket text frames',
)
assert.ok(
  programFrames().every(frame => frame.trim().split('\n').filter(Boolean).length === 1),
  'program commands should retain per-line framing',
)
const textCommands = socket.sent.filter((item): item is string => typeof item === 'string').map(item => item.trim())
assert.ok(textCommands.indexOf('$RI') < textCommands.indexOf('$RI=0'), 'stream must query the existing report interval before changing it')
assert.ok(textCommands.indexOf('$RI=0') < textCommands.findIndex(command => command.startsWith('G1 ')), 'auto-reporting must be disabled before G-code starts')

let acknowledged = 0
while (acknowledged < commands.length) {
  await waitFor(() => programMessages().length > acknowledged, `command ${acknowledged + 1} was not sent`)
  const sent = programMessages()
  const outstandingBytes = sent.slice(acknowledged)
    .reduce((total, command) => total + new TextEncoder().encode(command).byteLength + 1, 0)
  assert.ok(outstandingBytes <= 127 || sent[acknowledged].length > 127, `stream window overflowed: ${outstandingBytes}`)
  assert.ok(sent.length - acknowledged <= 8, `stream response window overflowed: ${sent.length - acknowledged} blocks`)
  socket.receive('ok\n')
  acknowledged++
}

socket.machineState = 'Idle'
useMachineStore.getState().updateStatus({ state: 'Idle' })
await waitFor(() => useGCodeSenderStore.getState().phase === 'completed', 'acknowledged stream did not complete')
assert.equal(useGCodeSenderStore.getState().completedBlocks, commands.length)
assert.equal(socket.reportInterval, 750, 'stream must restore the exact controller report interval')

useGCodeSenderStore.getState().dismiss()
assert.equal(useGCodeSenderStore.getState().start('G1 X1 F100', 'lost-ack.gcode'), true)
await waitFor(() => programMessages().filter(command => command === 'G1 X1 F100').length === 1, 'lost-ack test block was not sent')
await waitFor(() => useGCodeSenderStore.getState().phase === 'error', 'lost acknowledgement was not detected', 7000)
assert.match(useGCodeSenderStore.getState().error ?? '', /stopped acknowledging/)
assert.equal(socket.reportInterval, 750, 'error cleanup must restore the exact controller report interval')

useGCodeSenderStore.getState().dismiss()
socket.supportsReportInterval = false
const disableCommandsBeforeFallback = socket.sent.filter(item => typeof item === 'string' && item.trim() === '$RI=0').length
assert.equal(useGCodeSenderStore.getState().start('G1 X99 F100', 'legacy.gcode'), true)
await waitFor(() => programMessages().includes('G1 X99 F100'), 'legacy fallback stream did not start')
assert.equal(
  socket.sent.filter(item => typeof item === 'string' && item.trim() === '$RI=0').length,
  disableCommandsBeforeFallback,
  'unsupported firmware must not receive the report-disable command',
)
socket.machineState = 'Run'
useMachineStore.getState().updateStatus({ state: 'Run' })
socket.receive('ok\n')
socket.machineState = 'Idle'
useMachineStore.getState().updateStatus({ state: 'Idle' })
await waitFor(() => useGCodeSenderStore.getState().phase === 'completed', 'legacy fallback stream did not complete')

ws.disconnect()
console.log('G-code stream reliability tests passed')
