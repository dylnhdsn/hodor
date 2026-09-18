import { describe, expect, it } from 'vitest'
import { MemFs } from './fs.js'
import { listSkills, skillDescription } from './skills.js'

describe('skillDescription', () => {
  it('reads front matter, unquoted or quoted', () => {
    expect(skillDescription('---\nname: x\ndescription: Commit staged work\n---\n# Commit')).toBe(
      'Commit staged work',
    )
    expect(skillDescription('---\ndescription: "Ship it"\nallowed-tools: Bash\n---\n')).toBe('Ship it')
  })

  it('falls back to the first line after the front matter, sans heading marks', () => {
    expect(skillDescription('---\nallowed-tools: Bash\n---\n\n## Review the diff\nmore')).toBe(
      'Review the diff',
    )
    expect(skillDescription('Review the diff for bugs\n\nmore')).toBe('Review the diff for bugs')
    expect(skillDescription('')).toBeUndefined()
  })
})

describe('listSkills', () => {
  it('lists project then user skills and commands, project names shadowing', async () => {
    const fs = new MemFs()
    await fs.writeFile('/home/u/.claude/skills/commit/SKILL.md', '---\ndescription: Commit staged work\n---\n')
    await fs.writeFile('/home/u/.claude/commands/review.md', 'Review the diff for bugs\n')
    await fs.writeFile('/home/u/.claude/commands/notes.txt', 'not a command')
    await fs.writeFile('/repo/.claude/skills/deploy/SKILL.md', '---\ndescription: Ship it\n---\n')
    await fs.writeFile('/repo/.claude/skills/commit/SKILL.md', '# project commit\n')
    await fs.writeFile('/repo/.claude/skills/broken/README.md', 'no SKILL.md here')
    expect(await listSkills(fs, 'posix', '/home/u/.claude', '/repo')).toEqual([
      { name: 'commit', description: 'project commit', scope: 'project' },
      { name: 'deploy', description: 'Ship it', scope: 'project' },
      { name: 'review', description: 'Review the diff for bugs', scope: 'user' },
    ])
  })

  it('is empty without a cwd and with nothing on disk', async () => {
    expect(await listSkills(new MemFs(), 'posix', '/x/.claude', undefined)).toEqual([])
  })

  it('joins with the store flavor', async () => {
    const fs = new MemFs('\\')
    await fs.writeFile('C:\\Users\\u\\.claude\\skills\\ship\\SKILL.md', 'Ship\n')
    expect(await listSkills(fs, 'win32', 'C:\\Users\\u\\.claude', undefined)).toEqual([
      { name: 'ship', description: 'Ship', scope: 'user' },
    ])
  })
})
