import { describe, expect, it } from 'vitest'
import { MemFs } from './fs.js'
import { parseGitRemotes, pickRemoteUrl, resolveGitContext } from './git.js'

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:dylnhdsn/hodor.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "upstream"]
\turl = https://github.com/other/hodor.git
`

describe('parseGitRemotes', () => {
  it('extracts remote urls by name', () => {
    expect(parseGitRemotes(CONFIG)).toEqual({
      origin: 'git@github.com:dylnhdsn/hodor.git',
      upstream: 'https://github.com/other/hodor.git',
    })
  })

  it('prefers origin, falls back to the first remote', () => {
    expect(pickRemoteUrl({ origin: 'a', upstream: 'b' })).toBe('a')
    expect(pickRemoteUrl({ upstream: 'b' })).toBe('b')
    expect(pickRemoteUrl({})).toBeUndefined()
  })
})

describe('resolveGitContext', () => {
  it('resolves a normal repository from a nested cwd', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', CONFIG)
    fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main')
    fs.writeFile('/repo/src/deep/file.ts', '')
    expect(await resolveGitContext(fs, 'posix', '/repo/src/deep')).toEqual({
      repoRoot: '/repo',
      isWorktree: false,
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
  })

  it('resolves a linked worktree to its primary repository', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', CONFIG)
    fs.writeFile('/repo/.git/worktrees/wt1/commondir', '../..\n')
    fs.writeFile('/wt1/.git', 'gitdir: /repo/.git/worktrees/wt1\n')
    expect(await resolveGitContext(fs, 'posix', '/wt1')).toEqual({
      repoRoot: '/wt1',
      isWorktree: true,
      mainRepoRoot: '/repo',
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
  })

  it('resolves a worktree with a relative gitdir pointer', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', CONFIG)
    fs.writeFile('/repo/.git/worktrees/wt2/commondir', '../..\n')
    fs.writeFile('/repo/wt2/.git', 'gitdir: ../.git/worktrees/wt2\n')
    expect(await resolveGitContext(fs, 'posix', '/repo/wt2')).toMatchObject({
      repoRoot: '/repo/wt2',
      isWorktree: true,
      mainRepoRoot: '/repo',
    })
  })

  it('handles a repository without remotes', async () => {
    const fs = new MemFs()
    fs.writeFile('/local/.git/config', '[core]\n\tbare = false\n')
    expect(await resolveGitContext(fs, 'posix', '/local')).toEqual({
      repoRoot: '/local',
      isWorktree: false,
    })
  })

  it('returns null outside any repository', async () => {
    const fs = new MemFs()
    fs.writeFile('/somewhere/file.txt', '')
    expect(await resolveGitContext(fs, 'posix', '/somewhere')).toBeNull()
  })

  it('keeps walking up past a .git file with no gitdir pointer', async () => {
    const fs = new MemFs()
    fs.writeFile('/outer/.git/config', CONFIG)
    fs.writeFile('/outer/inner/.git', 'this is not a pointer\n')
    fs.writeFile('/outer/inner/x.txt', '')
    expect(await resolveGitContext(fs, 'posix', '/outer/inner')).toMatchObject({
      repoRoot: '/outer',
    })
  })

  it('treats a gitdir pointer without commondir (submodule) as its own repo', async () => {
    const fs = new MemFs()
    fs.writeFile('/parent/.git/modules/sub/config', '[remote "origin"]\n\turl = https://github.com/o/sub\n')
    fs.writeFile('/parent/sub/.git', 'gitdir: /parent/.git/modules/sub\n')
    expect(await resolveGitContext(fs, 'posix', '/parent/sub')).toEqual({
      repoRoot: '/parent/sub',
      isWorktree: false,
      remoteUrl: 'https://github.com/o/sub',
    })
  })

  it('resolves an absolute commondir', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', CONFIG)
    fs.writeFile('/repo/.git/worktrees/wt/commondir', '/repo/.git\n')
    fs.writeFile('/wt/.git', 'gitdir: /repo/.git/worktrees/wt\n')
    expect(await resolveGitContext(fs, 'posix', '/wt')).toMatchObject({
      isWorktree: true,
      mainRepoRoot: '/repo',
    })
  })

  it('ignores url lines outside remote sections and keeps the first url per remote', () => {
    const config = `url = ghost
[core]
\turl = also-not-a-remote
[remote "origin"]
\turl = first
\turl = second
[branch "main"]
\turl = nope
`
    expect(parseGitRemotes(config)).toEqual({ origin: 'first' })
  })

  it('works with win32 paths', async () => {
    const fs = new MemFs('\\')
    fs.writeFile('C:\\repo\\.git\\config', CONFIG)
    fs.writeFile('C:\\repo\\src\\a.ts', '')
    expect(await resolveGitContext(fs, 'win32', 'C:\\repo\\src')).toEqual({
      repoRoot: 'C:\\repo',
      isWorktree: false,
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
  })
})
