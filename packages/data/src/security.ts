import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDirectory } from './database'

export function hashToken(token: string) { return createHash('sha256').update(token).digest('hex') }
export function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex') }
export function passwordMatches(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const target = Buffer.from(hash, 'hex'); const actual = scryptSync(password, salt, 64)
  return target.length === actual.length && timingSafeEqual(target, actual)
}
function encryptionKey() {
  if (process.env.DATA_ENCRYPTION_KEY) return createHash('sha256').update(process.env.DATA_ENCRYPTION_KEY).digest()
  if (process.env.NODE_ENV === 'production') throw new Error('生产环境必须配置 DATA_ENCRYPTION_KEY')
  mkdirSync(dataDirectory, { recursive: true })
  const path = resolve(dataDirectory, 'encryption.key')
  try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (error: any) { if (error.code !== 'EEXIST') throw error }
  return readFileSync(path)
}
export function encrypt(value: string) {
  if (!value) return ''
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(item => item.toString('base64')).join('.')
}
export function decrypt(value: string) {
  if (!value) return ''
  const [iv, tag, data] = value.split('.').map(item => Buffer.from(item, 'base64'))
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv); cipher.setAuthTag(tag)
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8')
}
export function redact(value: any): any {
  if (typeof value === 'string' && value.startsWith('data:image/')) return '[图片内容已省略]'
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|key_cipher|apiKey|secret/i.test(key)).map(([key, item]) => [key, redact(item)]))
  return value
}
