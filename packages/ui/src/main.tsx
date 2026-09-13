import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { PopoutTerminal } from './Desk.js'
import { hydrateTheme, loadTheme } from './theme.js'
import './index.css'

loadTheme()
// The durable prefs live server-side (~/.hodor/ui.json) — overlay them
// once they arrive; localStorage above was only the first-paint guess.
void hydrateTheme()

// In the desktop app, a pop-out terminal window loads the same UI with
// #pty=<id> — it renders just that terminal, no manager around it.
const popoutId = window.location.hash.startsWith('#pty=')
  ? window.location.hash.slice('#pty='.length)
  : undefined

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popoutId !== undefined ? <PopoutTerminal ptyId={popoutId} /> : <App />}
  </StrictMode>,
)
