import { DomainError } from './index'
const maximum = 8 * 1024 * 1024
export function imageData(bytes: Buffer) {
  if (!bytes.length || bytes.length > maximum) throw new DomainError(400, '图片大小需在 1 字节至 8MB 之间')
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null
  if (!type) throw new DomainError(400, '仅支持有效的 PNG、JPEG、WebP 图片')
  return 'data:' + type + ';base64,' + bytes.toString('base64')
}
export async function persistProviderImage(item: any) {
  if (typeof item?.b64_json === 'string' && /^[A-Za-z0-9+/=]+$/.test(item.b64_json)) return imageData(Buffer.from(item.b64_json, 'base64'))
  if (typeof item?.url !== 'string' || !/^https?:\/\//i.test(item.url)) throw new DomainError(502, '供应商未返回有效图片')
  const response = await fetch(item.url, { signal: AbortSignal.timeout(25000) })
  if (!response.ok || !response.body) throw new DomainError(502, '无法保存供应商图片')
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > maximum) throw new DomainError(502, '供应商图片超过 8MB'); chunks.push(Buffer.from(result.value)) } }
  finally { await reader.cancel() }
  return imageData(Buffer.concat(chunks))
}
