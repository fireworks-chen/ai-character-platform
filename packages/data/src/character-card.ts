import { inflateSync } from 'node:zlib'
import { DomainError } from './index'
// SillyTavern PNG cards embed UTF-8 JSON in base64 tEXt chunks.
export function readCharacterCard(input: { card?: any; pngBase64?: string }) {
  let card = input.card
  if (input.pngBase64) {
    const data = Buffer.from(input.pngBase64, 'base64')
    if (data.length > 10000000 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new DomainError(400, '无效的 PNG 角色卡')
    let found = ''
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset); if (offset + 12 + length > data.length) throw new DomainError(400, 'PNG 数据不完整')
      const type = data.toString('ascii', offset + 4, offset + 8); const chunk = data.subarray(offset + 8, offset + 8 + length)
      if (type === 'tEXt' || type === 'zTXt') {
        const separator = chunk.indexOf(0); const keyword = chunk.subarray(0, separator).toString('ascii')
        if (separator >= 0 && ['chara', 'ccv3'].includes(keyword)) { const text = type === 'zTXt' ? inflateSync(chunk.subarray(separator + 2), { maxOutputLength: 200000 }).toString() : chunk.subarray(separator + 1).toString(); if (text.length > 200000) throw new DomainError(400, '角色卡元数据过大'); found = text; if (keyword === 'ccv3') break }
      }
      offset += length + 12
    }
    try { card = JSON.parse(Buffer.from(found, 'base64').toString('utf8')) } catch { throw new DomainError(400, '未找到有效的角色卡元数据') }
  }
  const value = card?.data || card
  if (!value || typeof value.name !== 'string' || typeof value.description !== 'string') throw new DomainError(400, '角色卡需要 name 和 description 字段')
  const personality = typeof value.personality === 'string' ? value.personality : ''
  const scenario = typeof value.scenario === 'string' ? value.scenario : ''
  const mesExample = typeof value.mes_example === 'string' ? value.mes_example : ''
  const systemPrompt = typeof value.system_prompt === 'string' ? value.system_prompt : typeof value.systemPrompt === 'string' ? value.systemPrompt : ''
  const greetings = Array.isArray(value.alternate_greetings) ? value.alternate_greetings.filter((item: any) => typeof item === 'string') : []
  const worldBook = value.world_book || value.worldBook || value.extensions?.world_book || []
  return { name: value.name, description: typeof value.description === 'string' ? value.description : '', personality, scenario, mesExample, systemPrompt, alternateGreetings: greetings, worldBook: worldBook && typeof worldBook === 'object' ? worldBook : [], extensions: value.extensions && typeof value.extensions === 'object' ? value.extensions : {}, creator: typeof value.creator === 'string' ? value.creator : '', characterVersion: typeof value.character_version === 'string' ? value.character_version : '1.0', creatorNotes: typeof value.creator_notes === 'string' ? value.creator_notes : '', opening: typeof value.first_mes === 'string' ? value.first_mes : '', tags: Array.isArray(value.tags) ? value.tags : [], published: false, cost: 10 }
}
