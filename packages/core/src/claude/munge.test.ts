import { describe, expect, it } from 'vitest'
import { MUNGED_DIR_MAX_LENGTH, matchesMungedDir, mungeCwd } from './munge.js'

describe('mungeCwd', () => {
  it('munges a posix path (verified against a live ~/.claude store)', () => {
    expect(mungeCwd('/home/user/hodor')).toEqual({
      kind: 'exact',
      dirName: '-home-user-hodor',
    })
  })

  it('munges a win32 path', () => {
    expect(mungeCwd('C:\\Users\\dylan\\proj')).toEqual({
      kind: 'exact',
      dirName: 'C--Users-dylan-proj',
    })
  })

  it('flattens dots and underscores, not just separators', () => {
    expect(mungeCwd('/home/user/my.app_v2')).toEqual({
      kind: 'exact',
      dirName: '-home-user-my-app-v2',
    })
  })

  it('is exact at exactly the max length', () => {
    const cwd = '/' + 'a'.repeat(MUNGED_DIR_MAX_LENGTH - 1)
    const result = mungeCwd(cwd)
    expect(result.kind).toBe('exact')
    if (result.kind === 'exact') {
      expect(result.dirName).toHaveLength(MUNGED_DIR_MAX_LENGTH)
    }
  })

  it('returns a truncated prefix one char past the max length', () => {
    const cwd = '/' + 'a'.repeat(MUNGED_DIR_MAX_LENGTH)
    const result = mungeCwd(cwd)
    expect(result).toEqual({
      kind: 'prefix',
      dirNamePrefix: ('-' + 'a'.repeat(MUNGED_DIR_MAX_LENGTH)).slice(0, MUNGED_DIR_MAX_LENGTH),
    })
  })
})

describe('matchesMungedDir', () => {
  it('matches an exact bucket name', () => {
    expect(matchesMungedDir('/home/user/hodor', '-home-user-hodor')).toBe(true)
  })

  it('rejects a different bucket name', () => {
    expect(matchesMungedDir('/home/user/hodor', '-home-user-other')).toBe(false)
  })

  it('matches a truncated bucket with an arbitrary hash suffix', () => {
    const cwd = '/' + 'a'.repeat(300)
    const munged = mungeCwd(cwd)
    expect(munged.kind).toBe('prefix')
    if (munged.kind === 'prefix') {
      expect(matchesMungedDir(cwd, `${munged.dirNamePrefix}-1x2y3z`)).toBe(true)
    }
  })

  it('rejects a truncated bucket whose suffix is not dash-separated', () => {
    const cwd = '/' + 'a'.repeat(300)
    const munged = mungeCwd(cwd)
    if (munged.kind === 'prefix') {
      expect(matchesMungedDir(cwd, `${munged.dirNamePrefix}x123`)).toBe(false)
    }
  })
})
