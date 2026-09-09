/**
 * Filesystem access behind an interface so the entire pipeline can run
 * against an in-memory fake in tests. Paths are plain absolute strings;
 * their flavor (posix vs win32) is the caller's concern — see paths.ts.
 */

export interface FsStat {
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
}

export interface FileSystem {
  stat(path: string): Promise<FsStat | undefined>
  /** Entry names directly under a directory; [] when missing or not a dir. */
  listDir(path: string): Promise<string[]>
  /** Whole file as UTF-8, or undefined when missing. */
  readFile(path: string): Promise<string | undefined>
  /** Bytes from `offset` to EOF, or undefined when missing. */
  readBytesFrom(path: string, offset: number): Promise<Uint8Array | undefined>
}

/**
 * In-memory FileSystem for tests. Directories are implicit: any path prefix
 * of a stored file is a directory. Separator is configurable so win32-shaped
 * trees can be simulated.
 */
export class MemFs implements FileSystem {
  private files = new Map<string, Uint8Array>()
  private mtimes = new Map<string, number>()
  private clock = 0

  constructor(private readonly sep: string = '/') {}

  writeFile(path: string, text: string): void {
    this.files.set(path, new TextEncoder().encode(text))
    this.mtimes.set(path, ++this.clock)
  }

  appendFile(path: string, text: string): void {
    this.appendBytes(path, new TextEncoder().encode(text))
  }

  appendBytes(path: string, added: Uint8Array): void {
    const existing = this.files.get(path) ?? new Uint8Array(0)
    const merged = new Uint8Array(existing.length + added.length)
    merged.set(existing, 0)
    merged.set(added, existing.length)
    this.files.set(path, merged)
    this.mtimes.set(path, ++this.clock)
  }

  removeFile(path: string): void {
    this.files.delete(path)
    this.mtimes.delete(path)
  }

  paths(): string[] {
    return [...this.files.keys()]
  }

  stat(path: string): Promise<FsStat | undefined> {
    const bytes = this.files.get(path)
    if (bytes !== undefined) {
      return Promise.resolve({ kind: 'file', size: bytes.length, mtimeMs: this.mtimes.get(path) ?? 0 })
    }
    const prefix = path + this.sep
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return Promise.resolve({ kind: 'dir', size: 0, mtimeMs: 0 })
    }
    return Promise.resolve(undefined)
  }

  listDir(path: string): Promise<string[]> {
    const prefix = path + this.sep
    const names = new Set<string>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const segment = rest.split(this.sep)[0]
      if (segment !== undefined && segment.length > 0) names.add(segment)
    }
    return Promise.resolve([...names].sort())
  }

  readFile(path: string): Promise<string | undefined> {
    const bytes = this.files.get(path)
    return Promise.resolve(bytes === undefined ? undefined : new TextDecoder().decode(bytes))
  }

  readBytesFrom(path: string, offset: number): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(path)
    return Promise.resolve(bytes?.slice(offset))
  }
}
