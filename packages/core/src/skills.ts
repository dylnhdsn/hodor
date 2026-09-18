import type { FileSystem } from './fs.js'
import { pathOps, type PathFlavor } from './paths.js'

/**
 * Skill lookup for the turn stack's preset chips (docs/brainstorm/029):
 * the slash commands a session can run. Project skills and commands live
 * under the session's cwd/.claude, user ones under the store's ~/.claude;
 * a project name shadows a user one, as in the CLI. Read-only probing —
 * a missing directory is simply no skills.
 */

export interface SkillInfo {
  /** What follows the slash. */
  name: string
  description?: string
  scope: 'user' | 'project'
}

const clip = (s: string): string => (s.length > 120 ? s.slice(0, 117) + '…' : s)

/** The description from SKILL.md front matter, else the file's first line. */
export function skillDescription(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (fm !== null) {
    const m = /^description:[ \t]*(.+)$/m.exec(fm[1]!)
    if (m !== null) return clip(m[1]!.trim().replace(/^(["'])(.*)\1$/, '$2'))
  }
  const body = fm !== null ? text.slice(fm[0].length) : text
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  return line !== undefined ? clip(line.replace(/^#+\s*/, '')) : undefined
}

export async function listSkills(
  fs: FileSystem,
  flavor: PathFlavor,
  storeRoot: string,
  cwd: string | undefined,
): Promise<SkillInfo[]> {
  const p = pathOps(flavor)
  const out: SkillInfo[] = []
  const seen = new Set<string>()
  const add = (name: string, text: string, scope: SkillInfo['scope']): void => {
    if (seen.has(name)) return
    seen.add(name)
    const description = skillDescription(text)
    out.push({ name, ...(description !== undefined ? { description } : {}), scope })
  }
  const probe = async (base: string, scope: SkillInfo['scope']): Promise<void> => {
    const skillsDir = p.join(base, 'skills')
    for (const name of (await fs.listDir(skillsDir)).sort()) {
      const text = await fs.readFile(p.join(skillsDir, name, 'SKILL.md'))
      if (text !== undefined) add(name, text, scope)
    }
    const commandsDir = p.join(base, 'commands')
    for (const file of (await fs.listDir(commandsDir)).sort()) {
      if (!file.endsWith('.md')) continue
      const text = await fs.readFile(p.join(commandsDir, file))
      if (text !== undefined) add(file.slice(0, -3), text, scope)
    }
  }
  if (cwd !== undefined) await probe(p.join(cwd, '.claude'), 'project')
  await probe(storeRoot, 'user')
  return out
}
