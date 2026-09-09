import { open, readdir, readFile, stat } from 'node:fs/promises'
import type { FileSystem, FsStat } from '../fs.js'

/** Real-filesystem adapter. Kept at the edge; tests use MemFs instead. */
export class NodeFs implements FileSystem {
  async stat(path: string): Promise<FsStat | undefined> {
    try {
      const s = await stat(path)
      if (s.isFile()) return { kind: 'file', size: s.size, mtimeMs: s.mtimeMs }
      if (s.isDirectory()) return { kind: 'dir', size: 0, mtimeMs: s.mtimeMs }
      return undefined
    } catch {
      return undefined
    }
  }

  async listDir(path: string): Promise<string[]> {
    try {
      return (await readdir(path)).sort()
    } catch {
      return []
    }
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  }

  async readBytesFrom(path: string, offset: number): Promise<Uint8Array | undefined> {
    let handle
    try {
      handle = await open(path, 'r')
      const size = (await handle.stat()).size
      const length = Math.max(0, size - offset)
      const buffer = new Uint8Array(length)
      if (length > 0) await handle.read(buffer, 0, length, offset)
      return buffer
    } catch {
      return undefined
    } finally {
      await handle?.close()
    }
  }
}
