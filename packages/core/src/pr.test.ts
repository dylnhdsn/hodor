import { describe, expect, it } from 'vitest'
import { normalizePr, normalizePrListing, prLabel } from './pr.js'

const AT = '2026-09-18T20:00:00.000Z'
const raw = {
  number: 68,
  url: 'https://github.com/o/r/pull/68',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  updatedAt: '2026-09-18T19:55:00Z',
  headRefOid: 'abc123',
}

describe('normalizePr', () => {
  it('keeps the summary and builds the fingerprint from what moves', () => {
    expect(normalizePr(raw, AT)).toEqual({
      number: 68,
      url: 'https://github.com/o/r/pull/68',
      state: 'open',
      review: 'changes requested',
      fingerprint: 'open|abc123|changes requested|2026-09-18T19:55:00Z',
      checkedAt: AT,
    })
    expect(normalizePr({ ...raw, state: 'MERGED', isDraft: true, reviewDecision: '' }, AT)).toMatchObject({
      state: 'merged',
      draft: true,
      fingerprint: 'merged|abc123||2026-09-18T19:55:00Z',
    })
  })

  // A push, a review, a comment: each changes the fingerprint; a re-check
  // with nothing new does not.
  it('changes the fingerprint exactly when the PR moved', () => {
    const a = normalizePr(raw, AT)!.fingerprint
    expect(normalizePr(raw, '2026-09-18T21:00:00.000Z')!.fingerprint).toBe(a)
    expect(normalizePr({ ...raw, headRefOid: 'def456' }, AT)!.fingerprint).not.toBe(a)
    expect(normalizePr({ ...raw, reviewDecision: 'APPROVED' }, AT)!.fingerprint).not.toBe(a)
    expect(normalizePr({ ...raw, updatedAt: '2026-09-18T20:30:00Z' }, AT)!.fingerprint).not.toBe(a)
  })

  it('rejects entries missing what a PR must have', () => {
    expect(normalizePr({ number: 1 }, AT)).toBeUndefined()
    expect(normalizePr('nope', AT)).toBeUndefined()
  })
})

describe('normalizePrListing', () => {
  it('reads the first PR, null for none, undefined for junk', () => {
    expect(normalizePrListing(JSON.stringify([raw]), AT)?.number).toBe(68)
    expect(normalizePrListing('[]', AT)).toBeNull()
    expect(normalizePrListing('gh: not logged in', AT)).toBeUndefined()
    expect(normalizePrListing('{"nope":1}', AT)).toBeUndefined()
    // shell noise around the array is ignored
    expect(normalizePrListing(`warning: x\n${JSON.stringify([raw])}\n`, AT)?.number).toBe(68)
  })
})

describe('prLabel', () => {
  it('says the number, state, and what needs saying', () => {
    expect(prLabel(normalizePr(raw, AT)!)).toBe('#68 open · changes requested')
    expect(prLabel(normalizePr({ ...raw, state: 'MERGED', reviewDecision: 'APPROVED', isDraft: true }, AT)!)).toBe(
      '#68 merged · draft · approved',
    )
  })
})
