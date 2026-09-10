import { describe, expect, it } from 'vitest'
import { driveMountTranslator, flavorOfPath, pathOps, wslUncTranslator } from './paths.js'

describe('pathOps', () => {
  it('joins with the flavor separator', () => {
    expect(pathOps('posix').join('/a', 'b')).toBe('/a/b')
    expect(pathOps('win32').join('C:\\a', 'b')).toBe('C:\\a\\b')
  })
})

describe('wslUncTranslator', () => {
  it('maps posix paths into the distro UNC tree', () => {
    const translate = wslUncTranslator('Ubuntu')
    expect(translate('/home/d/repo')).toBe('\\\\wsl$\\Ubuntu\\home\\d\\repo')
    expect(translate('/')).toBe('\\\\wsl$\\Ubuntu\\')
  })
})

describe('driveMountTranslator', () => {
  it('maps drive paths onto the WSL mount', () => {
    const translate = driveMountTranslator('/mnt')
    expect(translate('C:\\Users\\d\\app')).toBe('/mnt/c/Users/d/app')
    expect(translate('D:/data/x')).toBe('/mnt/d/data/x')
    expect(translate('C:\\')).toBe('/mnt/c/')
  })

  it('passes non-drive paths through untouched', () => {
    const translate = driveMountTranslator('/mnt')
    expect(translate('/already/posix')).toBe('/already/posix')
    expect(translate('\\\\wsl$\\Ubuntu\\home')).toBe('\\\\wsl$\\Ubuntu\\home')
  })
})

describe('flavorOfPath', () => {
  it('detects win32 shapes', () => {
    expect(flavorOfPath('\\\\wsl$\\Ubuntu\\home\\d\\.claude')).toBe('win32')
    expect(flavorOfPath('C:\\Users\\d')).toBe('win32')
    expect(flavorOfPath('C:/Users/d')).toBe('win32')
    expect(flavorOfPath('relative\\thing')).toBe('win32')
  })

  it('defaults to posix', () => {
    expect(flavorOfPath('/home/d/.claude')).toBe('posix')
    expect(flavorOfPath('plain')).toBe('posix')
  })
})
