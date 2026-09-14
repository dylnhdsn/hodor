import { fetchPrefs, savePref } from './prefs.js'

/**
 * OS notifications when a session flips to "needs you" while the window
 * is in the background. One boolean, durable in ~/.hodor/ui.json.
 */

let enabled = true
try {
  enabled = window.localStorage.getItem('hodor-notify') !== 'off'
} catch {
  // default on
}
void fetchPrefs().then((prefs) => {
  if (prefs['notify'] === 'off') enabled = false
  else if (prefs['notify'] === 'on') enabled = true
})

export const notifyEnabled = (): boolean => enabled

export function setNotifyEnabled(on: boolean): void {
  enabled = on
  savePref({ notify: on ? 'on' : 'off' })
  try {
    window.localStorage.setItem('hodor-notify', on ? 'on' : 'off')
  } catch {
    // cache only
  }
  // Web builds need the browser's permission; the desktop grants it.
  if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission()
  }
}

/** Fire one needs-you notification (no-op when off, unfocused-only). */
export function notifyNeedsYou(title: string, body: string): void {
  if (!enabled) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const note = new Notification(title, { body })
  note.onclick = () => window.focus()
}
