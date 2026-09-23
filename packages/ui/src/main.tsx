import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { PopoutTerminal } from './Desk.js'
import { hydrateTheme, loadTheme } from './theme.js'
import { ZoneWindow } from './ZoneWindow.js'
import './index.css'

loadTheme()
// The durable prefs live server-side (~/.hodor/ui.json) — overlay them
// once they arrive; localStorage above was only the first-paint guess.
void hydrateTheme()

// In the desktop app, pop-out windows load the same UI with a hash that
// says what they are: #pty=<id> is one terminal, #zone=<ws>/<group> is
// a zone's tabs, #workspace=<id> is a whole workspace (the app locked
// to it). No hash is the main window.
const hash = window.location.hash
const popoutId = hash.startsWith('#pty=') ? hash.slice('#pty='.length) : undefined
const zone = hash.startsWith('#zone=')
  ? hash.slice('#zone='.length).split('/').map(decodeURIComponent)
  : undefined
const workspaceId = hash.startsWith('#workspace=')
  ? decodeURIComponent(hash.slice('#workspace='.length))
  : undefined

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popoutId !== undefined ? (
      <PopoutTerminal ptyId={popoutId} />
    ) : zone !== undefined && zone.length === 2 ? (
      <ZoneWindow wsId={zone[0]!} groupId={zone[1]!} />
    ) : (
      <App workspaceId={workspaceId} />
    )}
  </StrictMode>,
)
