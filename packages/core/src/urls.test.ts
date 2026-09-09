import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normalizeGitUrl, repoNameOf } from './urls.js'

describe('normalizeGitUrl', () => {
  it('unifies ssh, scp-like, and https forms of the same repo', () => {
    const expected = 'github.com/dylnhdsn/hodor'
    expect(normalizeGitUrl('git@github.com:dylnhdsn/hodor.git')).toBe(expected)
    expect(normalizeGitUrl('https://github.com/dylnhdsn/hodor.git')).toBe(expected)
    expect(normalizeGitUrl('https://github.com/dylnhdsn/hodor')).toBe(expected)
    expect(normalizeGitUrl('ssh://git@github.com/dylnhdsn/hodor.git')).toBe(expected)
    expect(normalizeGitUrl('ssh://git@github.com:22/dylnhdsn/hodor.git')).toBe(expected)
    expect(normalizeGitUrl('HTTPS://GitHub.com/dylnhdsn/hodor/')).toBe('github.com/dylnhdsn/hodor')
  })

  it('leaves local paths alone', () => {
    expect(normalizeGitUrl('/srv/git/thing.git')).toBe('/srv/git/thing.git')
    expect(normalizeGitUrl('C:\\repos\\thing')).toBe('C:\\repos\\thing')
    expect(normalizeGitUrl('../relative/repo')).toBe('../relative/repo')
  })

  it('preserves the path case', () => {
    expect(normalizeGitUrl('git@github.com:Dylnhdsn/Hodor.git')).toBe('github.com/Dylnhdsn/Hodor')
  })

  it('is idempotent', () => {
    const hostArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 2, maxLength: 8 })
      .map((cs) => cs.join('') + '.com')
    const segArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'), {
        minLength: 1,
        maxLength: 10,
      })
      .map((cs) => cs.join(''))
    const urlArb = fc
      .tuple(
        fc.constantFrom('https://', 'ssh://git@', 'git@', 'git://'),
        hostArb,
        fc.array(segArb, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
      )
      .map(([proto, host, segs, dotGit]) => {
        const path = segs.join('/')
        const sep = proto === 'git@' ? ':' : '/'
        return `${proto}${host}${sep}${path}${dotGit ? '.git' : ''}`
      })
    fc.assert(
      fc.property(urlArb, (url) => {
        const once = normalizeGitUrl(url)
        expect(normalizeGitUrl(once)).toBe(once)
      }),
    )
  })

  it('makes protocol choice irrelevant to identity', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('github.com', 'gitlab.example.co'),
        fc.constantFrom('owner/repo', 'group/sub/repo'),
        fc.boolean(),
        (host, path, dotGit) => {
          const suffix = dotGit ? '.git' : ''
          const viaHttps = normalizeGitUrl(`https://${host}/${path}${suffix}`)
          const viaScp = normalizeGitUrl(`git@${host}:${path}${suffix}`)
          expect(viaScp).toBe(viaHttps)
          expect(viaHttps).toBe(`${host}/${path}`)
        },
      ),
    )
  })
})

describe('repoNameOf', () => {
  it('takes the last segment', () => {
    expect(repoNameOf('github.com/dylnhdsn/hodor')).toBe('hodor')
    expect(repoNameOf('weird')).toBe('weird')
  })

  it('skips empty segments', () => {
    expect(repoNameOf('a/b/')).toBe('b')
    expect(repoNameOf('a//b')).toBe('b')
    expect(repoNameOf('')).toBe('')
  })
})

describe('normalizeGitUrl details', () => {
  it('flips backslashes in the path portion', () => {
    expect(normalizeGitUrl('https://host.com/a\\b')).toBe('host.com/a/b')
  })

  it('strips ports and userinfo', () => {
    expect(normalizeGitUrl('https://user@host.com:8443/a/b.git')).toBe('host.com/a/b')
  })

  it('strips only a trailing .git, not one mid-path', () => {
    expect(normalizeGitUrl('https://host.com/a.git/b')).toBe('host.com/a.git/b')
  })
})
