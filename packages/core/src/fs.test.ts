import { describe, expect, it } from 'vitest'
import { MemFs } from './fs.js'

describe('MemFs', () => {
  it('stats files and implicit directories', async () => {
    const fs = new MemFs()
    fs.writeFile('/a/b/c.txt', 'hi')
    expect(await fs.stat('/a/b/c.txt')).toMatchObject({ kind: 'file', size: 2 })
    expect(await fs.stat('/a/b')).toMatchObject({ kind: 'dir' })
    expect(await fs.stat('/a')).toMatchObject({ kind: 'dir' })
    expect(await fs.stat('/nope')).toBeUndefined()
    expect(await fs.stat('/a/b/c.txt.more')).toBeUndefined()
  })

  it('lists direct children only, sorted', async () => {
    const fs = new MemFs()
    fs.writeFile('/d/z.txt', '')
    fs.writeFile('/d/a.txt', '')
    fs.writeFile('/d/sub/deep.txt', '')
    expect(await fs.listDir('/d')).toEqual(['a.txt', 'sub', 'z.txt'])
    expect(await fs.listDir('/d/sub')).toEqual(['deep.txt'])
    expect(await fs.listDir('/missing')).toEqual([])
    expect(await fs.listDir('/d/z.txt')).toEqual([])
  })

  it('reads bytes from an offset', async () => {
    const fs = new MemFs()
    fs.writeFile('/f', 'hello')
    expect(new TextDecoder().decode(await fs.readBytesFrom('/f', 2))).toBe('llo')
    expect((await fs.readBytesFrom('/f', 5))!.length).toBe(0)
    expect(await fs.readBytesFrom('/missing', 0)).toBeUndefined()
  })

  it('advances mtime on every write and append', async () => {
    const fs = new MemFs()
    fs.writeFile('/f', 'a')
    const first = (await fs.stat('/f'))!.mtimeMs
    fs.appendFile('/f', 'b')
    const second = (await fs.stat('/f'))!.mtimeMs
    expect(second).toBeGreaterThan(first)
    expect(await fs.readFile('/f')).toBe('ab')
    fs.removeFile('/f')
    expect(await fs.readFile('/f')).toBeUndefined()
  })
})
