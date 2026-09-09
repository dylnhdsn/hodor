import { describe, expect, it } from 'vitest'
import { run } from './main.js'

describe('run', () => {
  it('prints usage with no arguments', () => {
    const result = run([])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Usage:')
  })

  it('prints a semver version', () => {
    const result = run(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('prints the bucket name for a cwd', () => {
    const result = run(['bucket', '/home/user/hodor'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('-home-user-hodor')
  })

  it('fails on bucket without an argument', () => {
    expect(run(['bucket']).exitCode).toBe(1)
  })

  it('fails on unknown commands', () => {
    const result = run(['frobnicate'])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('unknown command: frobnicate')
  })
})
