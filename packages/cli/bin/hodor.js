#!/usr/bin/env node
import { run } from '../dist/main.js'

const { exitCode, output } = run(process.argv.slice(2))
if (output) process.stdout.write(output + '\n')
process.exit(exitCode)
