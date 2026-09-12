import { describe, expect, it } from 'vitest'
import { MemFs } from './fs.js'
import { branchKnownLocally, localRemotePath, parseGitRemotes, pickRemoteUrl, resolveGitContext } from './git.js'

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

  it('chases a local-path remote to the source repo real remote', async () => {
    const fs = new MemFs()
    fs.writeFile('/home/d/peri/.git/config', CONFIG)
    fs.writeFile('/home/d/peri-stable/.git/config', '[remote "origin"]\n\turl = /home/d/peri\n')
    expect(await resolveGitContext(fs, 'posix', '/home/d/peri-stable/docs')).toEqual({
      repoRoot: '/home/d/peri-stable',
      isWorktree: false,
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
  })

  it('chases through chains of local clones', async () => {
    const fs = new MemFs()
    fs.writeFile('/a/.git/config', CONFIG)
    fs.writeFile('/b/.git/config', '[remote "origin"]\n\turl = /a\n')
    fs.writeFile('/c/.git/config', '[remote "origin"]\n\turl = /b\n')
    expect(await resolveGitContext(fs, 'posix', '/c')).toMatchObject({
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
  })

  it('resolves relative and file:// local remotes', async () => {
    const fs = new MemFs()
    fs.writeFile('/home/d/peri/.git/config', CONFIG)
    fs.writeFile('/home/d/rel/.git/config', '[remote "origin"]\n\turl = ../peri\n')
    fs.writeFile('/home/d/filed/.git/config', '[remote "origin"]\n\turl = file:///home/d/peri\n')
    expect(await resolveGitContext(fs, 'posix', '/home/d/rel')).toMatchObject({
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
    expect(await resolveGitContext(fs, 'posix', '/home/d/filed')).toMatchObject({
      remoteUrl: 'git@github.com:dylnhdsn/hodor.git',
    })
  })

  it('survives clone cycles, keeping the local-path remote', async () => {
    const fs = new MemFs()
    fs.writeFile('/x/.git/config', '[remote "origin"]\n\turl = /y\n')
    fs.writeFile('/y/.git/config', '[remote "origin"]\n\turl = /x\n')
    expect(await resolveGitContext(fs, 'posix', '/x')).toEqual({
      repoRoot: '/x',
      isWorktree: false,
      remoteUrl: '/y',
    })
  })

  it('keeps the local-path remote when the source repo has no remote', async () => {
    const fs = new MemFs()
    fs.writeFile('/src/.git/config', '[core]\n\tbare = false\n')
    fs.writeFile('/copy/.git/config', '[remote "origin"]\n\turl = /src\n')
    expect(await resolveGitContext(fs, 'posix', '/copy')).toMatchObject({ remoteUrl: '/src' })
  })

  it('classifies local vs real remote urls', () => {
    expect(localRemotePath('/home/d/peri')).toBe('/home/d/peri')
    expect(localRemotePath('../peri')).toBe('../peri')
    expect(localRemotePath('file:///srv/git/x')).toBe('/srv/git/x')
    expect(localRemotePath('C:\\repos\\x')).toBe('C:\\repos\\x')
    expect(localRemotePath('git@github.com:o/r.git')).toBeUndefined()
    expect(localRemotePath('https://github.com/o/r')).toBeUndefined()
    expect(localRemotePath('ssh://git@host/o/r')).toBeUndefined()
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

describe('branchKnownLocally', () => {
  it('finds loose local and remote-tracking refs, nested names included', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', '')
    fs.writeFile('/repo/.git/refs/heads/claude/fix-thing', 'aaaa\n')
    fs.writeFile('/repo/.git/refs/remotes/origin/claude/other', 'bbbb\n')
    expect(await branchKnownLocally(fs, 'posix', '/repo', 'claude/fix-thing')).toBe(true)
    expect(await branchKnownLocally(fs, 'posix', '/repo', 'claude/other')).toBe(true)
    expect(await branchKnownLocally(fs, 'posix', '/repo', 'claude/gone')).toBe(false)
  })

  it('reads packed-refs in both namespaces', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', '')
    fs.writeFile(
      '/repo/.git/packed-refs',
      '# pack-refs with: peeled fully-peeled sorted\n' +
        'aaaa refs/heads/claude/packed-one\n' +
        'bbbb refs/remotes/origin/claude/packed-two\n' +
        '^cccc\n',
    )
    expect(await branchKnownLocally(fs, 'posix', '/repo', 'claude/packed-one')).toBe(true)
    expect(await branchKnownLocally(fs, 'posix', '/repo', 'claude/packed-two')).toBe(true)
    expect(await branchKnownLocally(fs, 'posix', '/repo', 'claude/unpacked')).toBe(false)
  })

  it('follows worktree indirection to the shared refs', async () => {
    const fs = new MemFs()
    fs.writeFile('/repo/.git/config', '')
    fs.writeFile('/repo/.git/refs/heads/claude/shared', 'aaaa\n')
    fs.writeFile('/repo/.git/worktrees/wt1/commondir', '../..\n')
    fs.writeFile('/wt1/.git', 'gitdir: /repo/.git/worktrees/wt1\n')
    expect(await branchKnownLocally(fs, 'posix', '/wt1', 'claude/shared')).toBe(true)
    expect(await branchKnownLocally(fs, 'posix', '/wt1', 'claude/gone')).toBe(false)
  })

  it('is false for a directory that is not a repository', async () => {
    expect(await branchKnownLocally(new MemFs(), 'posix', '/nowhere', 'main')).toBe(false)
  })
})
