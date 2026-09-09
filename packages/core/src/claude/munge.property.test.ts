import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MUNGED_DIR_MAX_LENGTH, matchesMungedDir, mungeCwd } from './munge.js'

const anyPath = fc.string({ unit: 'binary', maxLength: 300 })

/** Paths short enough that munging is always exact. */
const shortPath = fc.string({ unit: 'binary', maxLength: MUNGED_DIR_MAX_LENGTH })

const isAlphanumeric = (ch: string) => /^[a-zA-Z0-9]$/.test(ch)

describe('mungeCwd properties', () => {
  it('is deterministic', () => {
    fc.assert(
      fc.property(anyPath, (p) => {
        expect(mungeCwd(p)).toEqual(mungeCwd(p))
      }),
    )
  })

  it('only ever emits [a-zA-Z0-9-]', () => {
    fc.assert(
      fc.property(anyPath, (p) => {
        const result = mungeCwd(p)
        const name = result.kind === 'exact' ? result.dirName : result.dirNamePrefix
        expect(name).toMatch(/^[a-zA-Z0-9-]*$/)
      }),
    )
  })

  it('preserves length (in code units) for exact results, caps prefixes at the max', () => {
    fc.assert(
      fc.property(anyPath, (p) => {
        const result = mungeCwd(p)
        if (result.kind === 'exact') {
          expect(result.dirName).toHaveLength(p.length)
        } else {
          expect(result.dirNamePrefix).toHaveLength(MUNGED_DIR_MAX_LENGTH)
        }
      }),
    )
  })

  it('preserves alphanumerics in place and dashes everything else', () => {
    fc.assert(
      fc.property(shortPath, (p) => {
        const result = mungeCwd(p)
        expect(result.kind).toBe('exact')
        if (result.kind !== 'exact') return
        for (let i = 0; i < p.length; i++) {
          const expected = isAlphanumeric(p.charAt(i)) ? p.charAt(i) : '-'
          expect(result.dirName.charAt(i)).toBe(expected)
        }
      }),
    )
  })

  it('is idempotent: re-munging an exact result is a no-op', () => {
    fc.assert(
      fc.property(shortPath, (p) => {
        const result = mungeCwd(p)
        if (result.kind !== 'exact') return
        expect(mungeCwd(result.dirName)).toEqual(result)
      }),
    )
  })

  it('always matches the bucket the CLI would create for the same cwd', () => {
    // Simulates the CLI's dir naming, including the unpredictable base36
    // hash suffix in the truncated case.
    const base36Suffix = fc
      .string({ unit: fc.constantFrom(...'0123456789abcdefghijklmnopqrstuvwxyz'), minLength: 1, maxLength: 11 })
    fc.assert(
      fc.property(anyPath, base36Suffix, (p, suffix) => {
        const result = mungeCwd(p)
        const cliDirName =
          result.kind === 'exact' ? result.dirName : `${result.dirNamePrefix}-${suffix}`
        expect(matchesMungedDir(p, cliDirName)).toBe(true)
      }),
    )
  })
})
