import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import './store/terminal'
import './lib/jogWatchdog'
import { disconnect as disconnectWs } from './lib/ws'

if (import.meta.env.VITE_DEMO_MODE) {
  const { installDemoMode } = await import('./demo')
  installDemoMode()
}

window.addEventListener('pagehide', () => { disconnectWs() })

// Suppress expected connection errors
function isExpectedTransportError(reason: unknown): boolean {
  if (!reason) return false
  const msg = (reason instanceof Error ? reason.message : String(reason)).toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('load failed') ||           // Safari
    msg.includes('the operation was aborted') ||
    msg.includes('the user aborted') ||
    msg.includes('http timeout') ||
    msg.includes('websocket')
  )
}
window.addEventListener('unhandledrejection', (e) => {
  if (isExpectedTransportError(e.reason)) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
