import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Load root server environment without exposing it to either Vite frontend.
export function loadEnvironment() {
  const file = resolve(__dirname, '../../..', '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}
