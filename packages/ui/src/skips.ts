import type { CloudSession, Session } from '@hodor/core'
import { cloudNeedsYou } from './CloudSessions.js'
import { sigOfCloud, sigOfSession } from './data.js'
import { deskState, getDeskOps, isDeferred } from './Desk.js'
import { promptText } from './dialog.js'
import type { MenuItem } from './menu.js'

/** Skip predicates, signature-aware (see sigOfSession/sigOfCloud). */
export const localSkipped = (s: Session, nowMs: number): boolean =>
  isDeferred(s.id, sigOfSession(s), s.lastActivityAt, nowMs, undefined, s.pr?.fingerprint)
export const cloudSkipped = (c: CloudSession, nowMs: number): boolean =>
  isDeferred(c.id, sigOfCloud(c), c.updatedAt, nowMs)

/** Skip verbs shared by rows, tabs and bulk actions. */
export function skipLocal(s: Session, note?: string): void {
  getDeskOps()?.setDefer(s.id, {
    sig: sigOfSession(s),
    ...(note !== undefined && note.trim() !== '' ? { note: note.trim() } : {}),
  })
}
export function skipCloud(c: CloudSession, note?: string): void {
  getDeskOps()?.setDefer(c.id, {
    sig: sigOfCloud(c),
    ...(note !== undefined && note.trim() !== '' ? { note: note.trim() } : {}),
  })
}

function skipWithNote(s: Session): void {
  void promptText('skip with a note', {
    detail: 'shown on the row so you can reorient when it comes back',
    placeholder: 'waiting on the design review…',
    okLabel: 'skip',
  }).then((note) => {
    if (note !== undefined) skipLocal(s, note)
  })
}

/** The skip items for a local session's context menu: nothing unless it
 * is your turn; unskip when it is quiet; otherwise skip, skip with a
 * note, and (when a PR is known) skip until that PR moves. */
export function skipItemsOf(s: Session, nowMs: number): MenuItem[] {
  if (s.turn?.state !== 'waiting' || getDeskOps() === undefined) return []
  if (localSkipped(s, nowMs)) {
    return [{ label: 'unskip', onClick: () => getDeskOps()?.setDefer(s.id, undefined) }]
  }
  return [
    { label: 'skip', onClick: () => skipLocal(s) },
    { label: 'skip with a note…', onClick: () => skipWithNote(s) },
    ...(s.pr !== undefined
      ? [
          {
            label: `skip until PR #${s.pr.number} moves`,
            onClick: () =>
              getDeskOps()?.setDefer(s.id, {
                pr: { number: s.pr!.number, fingerprint: s.pr!.fingerprint },
              }),
          },
        ]
      : []),
  ]
}

export function skipItemsOfCloud(c: CloudSession, nowMs: number): MenuItem[] {
  if (!cloudNeedsYou(c) || getDeskOps() === undefined) return []
  if (cloudSkipped(c, nowMs)) {
    return [{ label: 'unskip', onClick: () => getDeskOps()?.setDefer(c.id, undefined) }]
  }
  return [
    { label: 'skip', onClick: () => skipCloud(c) },
    {
      label: 'skip with a note…',
      onClick: () =>
        void promptText('skip with a note', { okLabel: 'skip' }).then((note) => {
          if (note !== undefined) skipCloud(c, note)
        }),
    },
  ]
}

/** Why a session is skipped, for the row's second line. */
export const skipNoteOf = (id: string): string | undefined => deskState.defer[id]?.note
