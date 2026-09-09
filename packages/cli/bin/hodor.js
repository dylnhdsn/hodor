#!/usr/bin/env node
import { homedir } from 'node:os'
import { NodeFs } from '@hodor/core'
import { run } from '../dist/main.js'

const exitCode = await run(process.argv.slice(2), {
  fs: new NodeFs(),
  homedir: () => homedir(),
  platformFlavor: process.platform === 'win32' ? 'win32' : 'posix',
  now: () => new Date(),
  write: (text) => process.stdout.write(text),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
process.exit(exitCode)
