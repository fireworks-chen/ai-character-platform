import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database, dataDirectory, schema } from './database'
export { Database } from './database'
import { decrypt, encrypt, hashPassword, hashToken, passwordMatches, redact } from './security'
import { generateChat } from './ai-core'
import { readSse } from './sse'
import { readCharacterCard } from './character-card'
import { imageData, persistProviderImage } from './media'
import { normalizeProviderBaseUrl, fetchProviderModels } from './provider-connection'
export { loadEnvironment } from './environment'

export type Actor = { id: string; email: string; role: string }
export type Character = { id: string; name: string; subtitle: string; description: string; opening: string; tags: string[]; image: string; gender: string; cost: number; online: boolean; published: boolean }
export type Model = { id: string; name: string; baseUrl: string; model: string; apiKeyConfigured: boolean; task: string; inputRate: number; outputRate: number; cacheReadRate: number; cacheWriteRate: number; imageRate: number; enabled: boolean; isDefault: boolean }
export type Usage = { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; source: string }
type ChatStream = { signal: AbortSignal; delta: (text: string) => Promise<void>; phase?: (phase: 'thinking' | 'responding') => Promise<void> }
export class DomainError extends Error { constructor(public status: number, message: string) { super(message) } }
const fail = (status: number, message: string): never => { throw new DomainError(status, message) }
const now = () => new Date().toISOString()
const json = (value: any) => JSON.stringify(value)
const parse = (value: string) => JSON.parse(value)
type Query = <R = any>(sql: string, values?: any[]) => Promise<R[]>
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function text(value: any, label: string, maximum = 1000) { if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) fail(400, `${label}不能为空且最多 ${maximum} 字`); return value.trim() as string }
function number(value: any, label: string, min: number, max: number, integer = true) { if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) fail(400, `${label}需在 ${min} 至 ${max} 之间${integer ? '，且为整数' : ''}`); return value as number }
function choice(value: any, allowed: string[], label: string) { if (!allowed.includes(value)) fail(400, `${label}无效`); return value as string }
function bool(value: any, label: string) { if (typeof value !== 'boolean') fail(400, `${label}无效`); return value }
function url(value: any, label: string, relative = false) {
  if (relative && typeof value === 'string' && /^\/(?!\/)[^\\]*$/.test(value)) return value
  const result = text(value, label, 2000)
  try { const parsed = new URL(result); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error() } catch { fail(400, `${label}必须是 HTTP/HTTPS 地址`) }
  return result.replace(/\/$/, '')
}
function publicUser(row: any) { return { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status, membership: row.membership_until && row.membership_until < now() ? '基础会员' : row.membership, membershipUntil: row.membership_until, balance: Number(row.balance), frozen: Number(row.frozen), createdAt: row.created_at } }
function character(row: any): Character { return { id: row.id, name: row.name, subtitle: row.subtitle, description: row.description, opening: row.opening, tags: parse(row.tags), image: row.image, gender: row.gender, cost: Number(row.cost), online: !!row.online, published: !!row.published } }
function model(row: any): Model { return { id: row.id, name: row.name, baseUrl: normalizeProviderBaseUrl(row.base_url), model: row.model, apiKeyConfigured: !!row.key_cipher, task: row.task, inputRate: Number(row.input_rate), outputRate: Number(row.output_rate), cacheReadRate: Number(row.cache_read_rate), cacheWriteRate: Number(row.cache_write_rate), imageRate: Number(row.image_rate), enabled: !!row.enabled, isDefault: !!row.is_default } }
function ledger(row: any) { return { id: row.id, userId: row.user_id, type: row.type, amount: Number(row.amount), balanceAfter: Number(row.balance_after), referenceId: row.reference_id, reason: row.reason, createdAt: row.created_at } }
function plan(row: any) { return { id: row.id, name: row.name, type: row.type, price: Number(row.price), credits: Number(row.credits), days: Number(row.days), discount: Number(row.discount), enabled: !!row.enabled } }
function order(row: any) { return { id: row.id, orderNo: row.order_no, userId: row.user_id, user: row.email, plan: parse(row.plan_json).name, type: row.type, amount: Number(row.amount), credits: Number(row.credits), status: row.status, paymentUrl: row.payment_url, createdAt: row.created_at, paidAt: row.paid_at } }

export function calculateCharge(usage: Usage, pricing: Model, minimum: number, discount = 1) {
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens'] as const) number(usage[key], key, 0, 100000000)
  if (usage.cachedTokens + usage.cacheWriteTokens > usage.inputTokens) fail(400, '缓存 Token 数不能超过输入 Token 总数')
  const uncached = usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens
  const scaled = (value: number) => BigInt(Math.round(value * 10000))
  const total = BigInt(uncached) * scaled(pricing.inputRate) + BigInt(usage.cachedTokens) * scaled(pricing.cacheReadRate) + BigInt(usage.cacheWriteTokens) * scaled(pricing.cacheWriteRate) + BigInt(usage.outputTokens) * scaled(pricing.outputRate)
  const numerator = total * scaled(discount); const denominator = 100000000000n
  return Math.max(minimum, Number((numerator + denominator - 1n) / denominator))
}

export class PlatformStore {
  readonly db = new Database()
  readonly ready: Promise<void>
  private inFlight = new Map<string, Promise<any>>()
  private recoveryTimer?: ReturnType<typeof setInterval>
  constructor() { this.ready = this.initialize().then(async () => { await this.recoverExpired(); this.recoveryTimer = setInterval(() => this.recoverExpired().catch(error => console.error('Request recovery failed:', error.code || error.name)), 60000); this.recoveryTimer.unref() }) }
  async close() { await this.ready; clearInterval(this.recoveryTimer); await this.db.close() }
  private async rows<T = any>(sql: string, values: any[] = []) { await this.ready; return this.db.rows<T>(sql, values) }
  private async tx<T>(fn: (query: Query) => Promise<T>) { await this.ready; return this.db.transaction(fn) }
  private async initialize() {
    await this.db.transaction(async q => { await q('SELECT pg_advisory_xact_lock(726500)'); for (const sql of schema) await q(sql) })
    await this.db.transaction(async q => {
      for (const task of [
        ['daily-login', '每日签到', '完成今日签到', 10, 'daily'],
        ['chat-3', '聊天达人', '完成 3 条聊天消息', 20, 'daily'],
        ['explore-character', '探索角色', '开启一段新的角色对话', 15, 'daily'],
      ]) await q('INSERT INTO platform_tasks(id,code,name,description,reward,kind,enabled) VALUES(?,?,?,?,?,?,1) ON CONFLICT(code) DO NOTHING', [randomUUID(), ...task])
    })
    if (process.env.SKIP_BOOTSTRAP_ADMIN === 'true') return
    await this.db.transaction(async q => {
      await q('SELECT pg_advisory_xact_lock(726502)')
      if ((await q("SELECT id FROM platform_users WHERE role='admin' AND status='active'")).length) return
      const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@local.host'
      let password = process.env.BOOTSTRAP_ADMIN_PASSWORD
      if (!password && process.env.NODE_ENV === 'production') fail(503, '首次部署请配置 BOOTSTRAP_ADMIN_PASSWORD')
      if (!password) password = randomBytes(18).toString('base64url')
      if (password.length < 10) fail(503, '初始管理员密码至少 10 位')
      const id = randomUUID()
      await q(`INSERT INTO platform_users(id,email,name,password_hash,role,status,membership,balance,frozen,created_at,updated_at) VALUES(?,?,?,?,'admin','active','基础会员',0,0,?,?)`, [id, email.toLowerCase(), '管理员', hashPassword(password), now(), now()])
      await this.audit(q, { id, email, role: 'admin' }, 'system.bootstrap', id, null, { email }, '创建首个管理员')
      if (!process.env.BOOTSTRAP_ADMIN_PASSWORD) { mkdirSync(dataDirectory, { recursive: true }); writeFileSync(resolve(dataDirectory, 'admin-credentials.txt'), `管理端：http://localhost:4174\n邮箱：${email}\n初始密码：${password}\n请登录后在账号设置中修改密码。\n`, { mode: 0o600 }) }
    })
  }
  private async audit(q: Query, actor: Actor, action: string, target: string, before: any, after: any, reason = '') {
    await q('INSERT INTO platform_audit(id,actor_id,actor,action,target,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [randomUUID(), actor.id, actor.email, action, target, json(redact(before)), json(redact(after)), reason, now()])
  }
  private async activeUser(q: Query, id: string) { const row = (await q('SELECT * FROM platform_users WHERE id=?', [id]))[0]; if (!row || row.status !== 'active') fail(403, '账号已被停用或删除'); return row }
  async authenticate(token?: string): Promise<Actor> {
    if (!token) fail(401, '请先登录')
    const row = (await this.rows('SELECT u.* FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', [hashToken(token!), now()]))[0]
    if (!row || row.status !== 'active') fail(401, '登录已失效，请重新登录')
    return { id: row.id, email: row.email, role: row.role }
  }
  async login(email: string, password: string, admin = false) {
    const row = (await this.rows('SELECT * FROM platform_users WHERE email=?', [text(email, '邮箱', 254).toLowerCase()]))[0]
    if (!row || row.status !== 'active' || typeof password !== 'string' || !passwordMatches(password, row.password_hash) || (admin && !['admin', 'operator', 'auditor'].includes(row.role))) fail(401, '邮箱、密码错误或无权登录')
    const token = randomBytes(32).toString('base64url')
    await this.tx(async q => { await q('DELETE FROM platform_sessions WHERE expires_at<?', [now()]); await q('INSERT INTO platform_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', [hashToken(token), row.id, new Date(Date.now() + 86400000).toISOString()]); await this.audit(q, row, 'auth.login', row.id, null, null) })
    return { token, user: publicUser(row) }
  }
  async logout(token: string, actor: Actor) { await this.tx(async q => { await q('DELETE FROM platform_sessions WHERE token_hash=?', [hashToken(token)]); await this.audit(q, actor, 'auth.logout', actor.id, null, null) }); return { success: true } }
  async register(body: any) { return this.createUser({ id: 'registration', email: body.email, role: 'user' }, { ...body, role: 'user', membership: '基础会员', membershipUntil: null, balance: 0, status: 'active' }, true) }
  async me(actor: Actor) { return publicUser(await this.activeUser(this.rows.bind(this), actor.id)) }
  async profile(actor: Actor, body: any) {
    return this.tx(async q => {
      const before = await this.activeUser(q, actor.id); const name = body.name === undefined ? before.name : text(body.name, '昵称', 80)
      let passwordHash = before.password_hash
      if (body.password) { if (typeof body.currentPassword !== 'string' || !passwordMatches(body.currentPassword, before.password_hash)) fail(400, '当前密码错误'); passwordHash = hashPassword(text(body.password, '密码', 128)); if (body.password.length < 10) fail(400, '密码至少 10 位'); await q('DELETE FROM platform_sessions WHERE user_id=?', [actor.id]) }
      await q('UPDATE platform_users SET name=?,password_hash=?,updated_at=? WHERE id=?', [name, passwordHash, now(), actor.id]); await this.audit(q, actor, 'user.profile', actor.id, { name: before.name }, { name, passwordChanged: passwordHash !== before.password_hash })
      return publicUser({ ...before, name })
    })
  }
  async users() { return (await this.rows("SELECT * FROM platform_users WHERE status!='deleted' ORDER BY created_at DESC")).map(publicUser) }
  async createUser(actor: Actor, body: any, registration = false) {
    const email = text(body.email, '邮箱', 254).toLowerCase(); if (!emailPattern.test(email)) fail(400, '邮箱格式错误')
    const name = text(body.name, '昵称', 80); const password = text(body.password, '密码', 128); if (password.length < 10) fail(400, '密码至少 10 位')
    const role = choice(body.role || 'user', ['user', 'admin', 'operator', 'auditor'], '角色')
    const membership = text(body.membership || '基础会员', '会员', 80)
    const balance = number(body.balance ?? 0, '初始积分', 0, 1000000)
    if (body.membershipUntil && (typeof body.membershipUntil !== 'string' || Number.isNaN(Date.parse(body.membershipUntil)))) fail(400, '会员有效期无效')
    const membershipUntil = body.membershipUntil ? new Date(body.membershipUntil).toISOString() : null
    return this.tx(async q => {
      if ((await q('SELECT id FROM platform_users WHERE email=?', [email])).length) fail(409, '邮箱已存在')
      const id = randomUUID(); const row = { id, email, name, password_hash: hashPassword(password), role, status: 'active', membership, membership_until: membershipUntil, balance, frozen: 0, created_at: now() }
      await q('INSERT INTO platform_users(id,email,name,password_hash,role,status,membership,membership_until,balance,frozen,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, email, name, row.password_hash, role, 'active', membership, membershipUntil, balance, 0, row.created_at, row.created_at])
      if (balance) await this.writeLedger(q, id, 'admin_adjustment', balance, balance, id, '创建账户时分配积分', 'initial:' + id)
      await this.audit(q, registration ? { id, email, role } : actor, registration ? 'user.register' : 'user.create', id, null, publicUser(row))
      return publicUser(row)
    })
  }
  async updateUser(actor: Actor, id: string, body: any) {
    return this.tx(async q => {
      const row = (await q("SELECT * FROM platform_users WHERE id=? AND status!='deleted'", [id]))[0]; if (!row) fail(404, '用户不存在')
      const name = body.name === undefined ? row.name : text(body.name, '昵称', 80)
      const email = body.email === undefined ? row.email : text(body.email, '邮箱', 254).toLowerCase(); if (!emailPattern.test(email)) fail(400, '邮箱格式错误')
      const status = body.status === undefined ? row.status : choice(body.status, ['active', 'disabled'], '状态')
      const role = body.role === undefined ? row.role : choice(body.role, ['user', 'admin', 'operator', 'auditor'], '角色')
      if (id === actor.id && (status !== 'active' || role !== row.role)) fail(400, '不能停用自己或修改自己的角色')
      const admins = await q("SELECT id FROM platform_users WHERE role='admin' AND status='active'" + (this.db.backend === 'PostgreSQL' ? ' FOR UPDATE' : ''))
      if (row.role === 'admin' && (status !== 'active' || role !== 'admin') && admins.length < 2) fail(400, '不能移除最后一个管理员')
      if ((await q('SELECT id FROM platform_users WHERE email=? AND id!=?', [email, id])).length) fail(409, '邮箱已存在')
      let passwordHash = row.password_hash
      if (body.password) { const password = text(body.password, '密码', 128); if (password.length < 10) fail(400, '密码至少 10 位'); passwordHash = hashPassword(password) }
      const membership = body.membership === undefined ? row.membership : text(body.membership, '会员', 80)
      const rawUntil = body.membershipUntil === undefined ? row.membership_until : body.membershipUntil
      if (rawUntil && (typeof rawUntil !== 'string' || Number.isNaN(Date.parse(rawUntil)))) fail(400, '会员有效期无效')
      const until = rawUntil ? new Date(rawUntil).toISOString() : null
      await q('UPDATE platform_users SET email=?,name=?,status=?,role=?,password_hash=?,membership=?,membership_until=?,updated_at=? WHERE id=?', [email, name, status, role, passwordHash, membership, until || null, now(), id])
      if (passwordHash !== row.password_hash || status !== row.status || role !== row.role) await q('DELETE FROM platform_sessions WHERE user_id=?', [id])
      const result = publicUser({ ...row, email, name, status, role, membership, membership_until: until }); await this.audit(q, actor, 'user.update', id, publicUser(row), result); return result
    })
  }
  async deleteUser(actor: Actor, id: string, reason: string) {
    text(reason, '删除原因', 200)
    return this.tx(async q => {
      const row = (await q("SELECT * FROM platform_users WHERE id=? AND status!='deleted'", [id]))[0]; if (!row) fail(404, '用户不存在')
      if (actor.id === id) fail(400, '不能删除当前管理员')
      const admins = await q("SELECT id FROM platform_users WHERE role='admin' AND status='active'" + (this.db.backend === 'PostgreSQL' ? ' FOR UPDATE' : ''))
      if (row.role === 'admin' && admins.length < 2) fail(400, '不能删除最后一个管理员')
      if (Number(row.frozen)) fail(409, '账户有待结算请求，请稍后再删除')
      await q("UPDATE platform_users SET status='deleted',updated_at=? WHERE id=?", [now(), id]); await q('DELETE FROM platform_sessions WHERE user_id=?', [id]); await this.audit(q, actor, 'user.delete', id, publicUser(row), { status: 'deleted' }, reason); return { success: true }
    })
  }
  async characters(publicOnly = false) { return (await this.rows(`SELECT * FROM platform_characters WHERE deleted=0 ${publicOnly ? 'AND published=1' : ''} ORDER BY created_at DESC`)).map(character) }
  async creatorCharacters(actor: Actor) { return (await this.rows('SELECT c.* FROM platform_characters c JOIN platform_character_meta m ON m.character_id=c.id WHERE c.deleted=0 AND m.creator_id=? ORDER BY c.updated_at DESC', [actor.id])).map(character) }
  async getCharacter(id: string, publicOnly = true) { const row = (await this.rows(`SELECT * FROM platform_characters WHERE id=? AND deleted=0 ${publicOnly ? 'AND published=1' : ''}`, [id]))[0]; if (!row) fail(404, '角色不存在或已下架'); return character(row) }
  async saveCharacter(actor: Actor, id: string | null, body: any) {
    return this.tx(async q => {
      const before = id ? (await q('SELECT * FROM platform_characters WHERE id=? AND deleted=0', [id]))[0] : null
      if (id && !before) fail(404, '角色不存在')
      if (id && !['admin', 'operator'].includes(actor.role)) { const owner = (await q('SELECT creator_id FROM platform_character_meta WHERE character_id=?', [id]))[0]; if (owner?.creator_id && owner.creator_id !== actor.id) fail(403, '只能编辑自己创建的角色') }
      const merged = { ...(before ? character(before) : { subtitle: '', opening: '', tags: [], image: '/art/character-hero.png', gender: 'other', cost: 10, online: true, published: false }), ...body }
      const name = text(merged.name, '名称', 80); const description = text(merged.description, '角色设定', 12000)
      const subtitle = String(merged.subtitle || '').slice(0, 200); const opening = String(merged.opening || '').slice(0, 2000)
      if (!Array.isArray(merged.tags) || merged.tags.length > 10 || !merged.tags.every((tag: any) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 30)) fail(400, '标签最多 10 个，每个最多 30 字')
      const tags = [...new Set(merged.tags.map((tag: string) => tag.trim()))]
      let image: string
      if (typeof merged.image === 'string' && merged.image.startsWith('data:')) {
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(merged.image)
        if (!match || merged.image.length > 12000000) fail(400, '封面图片数据无效')
        image = imageData(Buffer.from(match![2], 'base64'))
        if (image !== merged.image) fail(400, '封面图片类型与内容不一致')
      } else image = url(merged.image, '封面', true)
      const gender = choice(merged.gender, ['female', 'male', 'other'], '性别'); const cost = number(merged.cost, '最低积分', 1, 10000); const online = bool(merged.online, '在线状态'); const published = bool(merged.published, '发布状态')
      const target = id || randomUUID(); const result = { id: target, name, description, subtitle, opening, tags, image, gender, cost, online, published }
      if (id) await q('UPDATE platform_characters SET name=?,subtitle=?,description=?,opening=?,tags=?,image=?,gender=?,cost=?,online=?,published=?,updated_at=? WHERE id=?', [name, subtitle, description, opening, json(tags), image, gender, cost, +online, +published, now(), target])
      else await q('INSERT INTO platform_characters(id,name,subtitle,description,opening,tags,image,gender,cost,online,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [target, name, subtitle, description, opening, json(tags), image, gender, cost, +online, +published, now(), now()])
      await q('INSERT INTO platform_character_meta(character_id,creator_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET creator_id=coalesce(platform_character_meta.creator_id,excluded.creator_id),updated_at=excluded.updated_at', [target, actor.id, now(), now()])
      await this.audit(q, actor, id ? 'character.update' : 'character.create', target, before ? character(before) : null, result); return result
    })
  }
  async deleteCharacter(actor: Actor, id: string, reason: string) {
    text(reason, '删除原因', 200)
    return this.tx(async q => { const before = (await q('SELECT * FROM platform_characters WHERE id=? AND deleted=0', [id]))[0]; if (!before) fail(404, '角色不存在'); await q('UPDATE platform_characters SET deleted=1,published=0,updated_at=? WHERE id=?', [now(), id]); await this.audit(q, actor, 'character.delete', id, character(before), null, reason); return { success: true } })
  }
  async importCharacter(actor: Actor, body: any) { try { const card = readCharacterCard(body) as any; const result = await this.saveCharacter(actor, null, card); await this.saveCharacterMeta(actor, result.id, { ...card, extensions: { ...(card.extensions || {}), mes_example: card.mesExample, creator_notes: card.creatorNotes, creator: card.creator, character_version: card.characterVersion } }); return result } catch (error) { if (error instanceof DomainError) throw error; fail(400, '角色卡解析失败，请检查 JSON / PNG 文件') } }
  async exportCharacter(id: string) { const ch = await this.getCharacter(id, false); const meta = await this.characterMeta(id); return { spec: 'chara_card_v2', spec_version: '2.0', data: { name: ch.name, description: ch.description, personality: meta.personality, scenario: meta.scenario, system_prompt: meta.systemPrompt, first_mes: ch.opening, alternate_greetings: meta.alternateGreetings, mes_example: meta.extensions?.mes_example || '', tags: ch.tags, creator: meta.extensions?.creator || '', character_version: meta.extensions?.character_version || '1.0', creator_notes: meta.extensions?.creator_notes || '', extensions: { ...meta.extensions, world_book: meta.worldBook } } } }
  async favoriteCharacters(actor: Actor) { return (await this.rows('SELECT c.* FROM platform_favorites f JOIN platform_characters c ON c.id=f.character_id WHERE f.user_id=? AND c.deleted=0 AND c.published=1', [actor.id])).map(character) }
  async favoriteCharacter(actor: Actor, id: string, favorite: boolean) { await this.getCharacter(id); bool(favorite, '收藏'); if (favorite) await this.rows('INSERT INTO platform_favorites(user_id,character_id) VALUES(?,?) ON CONFLICT(user_id,character_id) DO NOTHING', [actor.id, id]); else await this.rows('DELETE FROM platform_favorites WHERE user_id=? AND character_id=?', [actor.id, id]); return { favorite } }
  async models() { return (await this.rows('SELECT * FROM platform_models ORDER BY created_at')).map(model) }
  async saveModel(actor: Actor, id: string | null, body: any) {
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') fail(400, 'API Key 必须是字符串')
    return this.tx(async q => {
      const before = id ? (await q('SELECT * FROM platform_models WHERE id=?', [id]))[0] : null; if (id && !before) fail(404, '模型不存在')
      const value = { ...(before ? model(before) : { inputRate: 0, outputRate: 0, cacheReadRate: 0, cacheWriteRate: 0, imageRate: 1, task: 'chat', enabled: true, isDefault: false }), ...body }
      const name = text(value.name, '配置名称', 80); const baseUrl = normalizeProviderBaseUrl(text(value.baseUrl, '服务地址', 2000)); const modelName = text(value.model, '模型名称', 160)
      const parsedUrl = new URL(baseUrl); if (parsedUrl.search || parsedUrl.hash) fail(400, '服务地址不能包含查询参数或锚点')
      const input = number(value.inputRate, '输入单价', 0, 100000, false); const output = number(value.outputRate, '输出单价', 0, 100000, false); const read = number(value.cacheReadRate, '缓存命中单价', 0, 100000, false); const write = number(value.cacheWriteRate, '缓存写入单价', 0, 100000, false)
      if ([input, output, read, write].some(rate => Math.abs(rate * 10000 - Math.round(rate * 10000)) > 0.00001)) fail(400, '计费单价最多保留 4 位小数')
      const imageRate = number(value.imageRate, '生图积分', 1, 100000); const task = choice(value.task, ['chat', 'image'], '任务类型'); const enabled = bool(value.enabled, '状态'); let isDefault = bool(value.isDefault, '默认模型')
      if (before?.is_default && task !== before.task) fail(409, '请先为原任务选择其他默认模型，再修改任务类型')
      if (isDefault && !enabled) fail(400, '默认模型必须启用')
      if (before?.is_default && (task !== before.task || !enabled) && !isDefault) fail(400, '请先指定其他默认模型')
      const key = body.apiKey?.trim() ? encrypt(text(body.apiKey, 'API Key', 1000)) : before?.key_cipher || ''
      if (isDefault && !key) fail(400, '默认模型必须先保存 API Key')
      if (before?.is_default && !isDefault) fail(409, '请先将其他同类模型设为默认，再取消当前默认模型')
      const target = id || randomUUID()
      // Serialize default selection across PostgreSQL connections.
      if (this.db.backend === 'PostgreSQL') await q('SELECT pg_advisory_xact_lock(726501)')
      if (!isDefault && enabled && key && !(await q('SELECT id FROM platform_models WHERE task=? AND is_default=1', [task])).length) isDefault = true
      if (isDefault) await q('UPDATE platform_models SET is_default=0 WHERE task=?', [task])
      if (id) await q('UPDATE platform_models SET name=?,base_url=?,model=?,key_cipher=?,task=?,input_rate=?,output_rate=?,cache_read_rate=?,cache_write_rate=?,image_rate=?,enabled=?,is_default=?,updated_at=? WHERE id=?', [name, baseUrl, modelName, key, task, input, output, read, write, imageRate, +enabled, +isDefault, now(), target])
      else await q('INSERT INTO platform_models(id,name,base_url,model,key_cipher,task,input_rate,output_rate,cache_read_rate,cache_write_rate,image_rate,enabled,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [target, name, baseUrl, modelName, key, task, input, output, read, write, imageRate, +enabled, +isDefault, now(), now()])
      const result = { id: target, name, baseUrl, model: modelName, apiKeyConfigured: !!key, task, inputRate: input, outputRate: output, cacheReadRate: read, cacheWriteRate: write, imageRate, enabled, isDefault }; await this.audit(q, actor, id ? 'model.update' : 'model.create', target, before ? model(before) : null, result); return result
    })
  }
  async deleteModel(actor: Actor, id: string) { return this.tx(async q => { const before = (await q('SELECT * FROM platform_models WHERE id=?', [id]))[0]; if (!before) fail(404, '模型不存在'); if (before.is_default) fail(409, '请先指定其他默认模型，再删除当前默认模型'); await q('DELETE FROM platform_models WHERE id=?', [id]); await this.audit(q, actor, 'model.delete', id, model(before), null); return { success: true } }) }
  async provider() { return (await this.models()).find(item => item.task === 'chat' && item.isDefault) || null }
  async updateProvider(actor: Actor, body: any) { const current = await this.provider(); return this.saveModel(actor, current?.id || null, { name: current?.name || '默认聊天模型', ...body, task: 'chat', isDefault: true }) }
  private async configuredModel(task: string) {
    const label = task === 'chat' ? '聊天' : '生图'
    const row = (await this.rows('SELECT * FROM platform_models WHERE task=? AND is_default=1', [task]))[0]
    if (!row) {
      const ready = (await this.rows("SELECT id FROM platform_models WHERE task=? AND enabled=1 AND key_cipher!='' LIMIT 1", [task]))[0]
      if (ready) fail(503, `已有${label}模型，但尚未指定默认模型，请在后台「模型与计费」设置默认模型`)
      fail(503, `尚未配置可用的${label}模型，请联系管理员`)
    }
    if (!row.enabled) fail(503, `默认${label}模型已停用，请在后台启用或更换默认模型`)
    if (!row.key_cipher) fail(503, `默认${label}模型尚未保存 API Key，请联系管理员`)
    return row
  }
  async testModel(actor: Actor, id: string) {
    const row = (await this.rows('SELECT * FROM platform_models WHERE id=?', [id]))[0]; if (!row?.key_cipher) fail(400, '模型不存在或未保存密钥')
    const key = decrypt(row.key_cipher)
    let outcome = '连接成功，模型列表和实际聊天请求均正常'
    const models = await fetchProviderModels(row.base_url, key)
    if (!models.includes(row.model)) outcome = '连接成功，但模型列表中未找到该名称，请确认模型可用'
    // A /models response only proves credentials, not that this model has a usable
    // upstream. Run a tiny real completion through the configured SillyTavern Core.
    const response = await generateChat({ baseUrl: row.base_url, apiKey: key, model: row.model, messages: [{ role: 'user', content: '请只回复：连接测试成功' }] })
    const data = await response.json().catch(() => null) as any
    if (!response.ok || data?.error || typeof data?.choices?.[0]?.message?.content !== 'string') {
      const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || `HTTP ${response.status}`
      fail(502, `模型列表可读取，但实际聊天请求失败：${String(detail).slice(0, 300)}`)
    }
    await this.tx(q => this.audit(q, actor, 'model.test', id, null, { outcome })); return { success: true, message: outcome }
  }
  async discoverModels(actor: Actor, body: any) {
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') fail(400, 'API Key 必须是字符串')
    const saved = body.id ? (await this.rows('SELECT * FROM platform_models WHERE id=?', [body.id]))[0] : null
    if (body.id && !saved) fail(404, '模型配置不存在')
    const baseUrl = normalizeProviderBaseUrl(text(body.baseUrl ?? saved?.base_url, '服务地址', 2000))
    const parsedUrl = new URL(baseUrl); if (parsedUrl.search || parsedUrl.hash) fail(400, '服务地址不能包含查询参数或锚点')
    // A stored credential may only be sent to the address it was saved for.
    if (!body.apiKey?.trim() && saved && normalizeProviderBaseUrl(saved.base_url) !== baseUrl) fail(400, '服务地址已改变，请重新填写该供应商的 API Key')
    const apiKey = body.apiKey?.trim() ? text(body.apiKey, 'API Key', 1000) : saved?.key_cipher ? decrypt(saved.key_cipher) : ''
    if (!apiKey) fail(400, '请先填写服务地址和 API Key')
    const models = await fetchProviderModels(baseUrl, apiKey)
    await this.tx(q => this.audit(q, actor, 'model.discover', saved?.id || 'provider', null, { baseUrl, count: models.length }))
    return { models, baseUrl }
  }
  async coverModels() { return (await this.models()).filter(item => item.task === 'image' && item.enabled && item.apiKeyConfigured).map(item => ({ id: item.id, name: item.name, model: item.model, isDefault: item.isDefault })) }
  async uploadCharacterCover(actor: Actor, body: any) {
    const result = await this.uploadImage(actor, body)
    await this.tx(q => this.audit(q, actor, 'character.cover.upload', result.id, null, { name: result.prompt }))
    return result
  }
  async generateCharacterCover(actor: Actor, body: any) {
    const prompt = text(body.prompt, '封面描述', 2000); const requestId = text(body.requestId, '请求 ID', 128)
    const pricing = body.modelId ? (await this.rows("SELECT * FROM platform_models WHERE id=? AND task='image' AND enabled=1", [text(body.modelId, '生图模型', 128)]))[0] : await this.configuredModel('image')
    if (!pricing?.key_cipher) fail(400, '请选择已配置密钥且已启用的生图模型')
    const key = `cover:${actor.id}:${requestId}`; const payload = json({ prompt, modelId: pricing.id })
    // Content production is an administrative operation and does not debit a user's wallet.
    const previous = await this.reserve(actor, key, payload, 0); if (previous) return previous
    try {
      const response = await fetch(normalizeProviderBaseUrl(pricing.base_url) + '/images/generations', { method: 'POST', headers: { authorization: 'Bearer ' + decrypt(pricing.key_cipher), 'content-type': 'application/json' }, body: json({ model: pricing.model, prompt, n: 1, size: '1024x1024' }), signal: AbortSignal.timeout(120000) })
      if (!response.ok) fail(502, `生图供应商返回 HTTP ${response.status}`)
      const data = await response.json() as any; const imageUrl = await persistProviderImage(data.data?.[0])
      return await this.tx(async q => {
        await q('SELECT id FROM platform_users WHERE id=? FOR UPDATE', [actor.id])
        const pending = (await q("SELECT request_key FROM platform_requests WHERE request_key=? AND status='pending' FOR UPDATE", [key]))[0]; if (!pending) fail(409, '生成请求已结束，请刷新素材列表')
        await this.activeUser(q, actor.id)
        const id = randomUUID(); const result = { id, url: imageUrl, prompt, credits: 0 }
        await q('INSERT INTO platform_images(id,user_id,url,prompt,credits,created_at) VALUES(?,?,?,?,0,?)', [id, actor.id, imageUrl, prompt, now()])
        await q("UPDATE platform_requests SET status='completed',result=? WHERE request_key=?", [json(result), key])
        await this.audit(q, actor, 'character.cover.generate', id, null, { name: prompt, model: pricing.model })
        return result
      })
    } catch (error) { await this.refund(actor, key); if (error instanceof DomainError) throw error; fail(502, '封面生成失败，请检查生图模型配置后重试') }
  }
  async estimate(body: any) { const selected = (await this.models()).find(item => item.id === body.modelId); if (!selected) fail(404, '模型不存在'); const usage = { inputTokens: body.inputTokens ?? 0, outputTokens: body.outputTokens ?? 0, cachedTokens: body.cachedTokens ?? 0, cacheWriteTokens: body.cacheWriteTokens ?? 0, source: 'calculator' }; return { chargedCredits: calculateCharge(usage, selected!, number(body.minimum ?? 1, '最低积分', 0, 10000)), usage } }
  private async writeLedger(q: Query, userId: string, type: string, amount: number, balance: number, referenceId: string, reason: string, requestKey: string) { await q('INSERT INTO platform_ledger(id,user_id,type,amount,balance_after,reference_id,reason,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [randomUUID(), userId, type, amount, balance, referenceId, reason, requestKey, now()]) }
  async adjustCredits(actor: Actor, id: string, dto: any) {
    const amount = number(dto.amount, '积分调整', -1000000, 1000000); if (!amount) fail(400, '调整值不能为零'); const reason = text(dto.reason, '原因', 200); const requestId = text(dto.requestId, '请求 ID', 128); const key = `adjust:${id}:${requestId}`
    return this.tx(async q => {
      const row = await this.activeUser(q, id)
      if (this.db.backend === 'PostgreSQL') await q('SELECT id FROM platform_users WHERE id=? FOR UPDATE', [id])
      const previous = (await q('SELECT * FROM platform_ledger WHERE request_key=?', [key]))[0]
      if (previous) { if (Number(previous.amount) !== amount || previous.reason !== reason) fail(409, '重复请求的内容不一致'); return { userId: id, balance: Number(previous.balance_after), duplicate: true } }
      const updated = (await q('UPDATE platform_users SET balance=balance+?,updated_at=? WHERE id=? AND status=\'active\' AND balance+?>=0 RETURNING balance', [amount, now(), id, amount]))[0]; if (!updated) fail(400, '调整后可用余额不能小于零')
      await this.writeLedger(q, id, 'admin_adjustment', amount, Number(updated.balance), requestId, reason, key); await this.audit(q, actor, 'credits.adjust', id, { balance: Number(updated.balance) - amount }, { balance: Number(updated.balance), amount }, reason); return { userId: id, balance: Number(updated.balance) }
    })
  }
  async ledgers(userId?: string) { return (await this.rows(`SELECT * FROM platform_ledger ${userId ? 'WHERE user_id=?' : ''} ORDER BY created_at DESC LIMIT 1000`, userId ? [userId] : [])).map(ledger) }
  async wallet(actor: Actor) { const user = await this.me(actor); return { balance: user.balance, frozen: user.frozen, membership: user.membership, membershipUntil: user.membershipUntil, ledger: await this.ledgers(actor.id) } }
  async logs() {
    const labels: Record<string, string> = { 'system.bootstrap': '创建初始管理员', 'auth.login': '登录账号', 'auth.logout': '退出登录', 'user.register': '注册账号', 'user.profile': '修改个人资料', 'user.create': '添加用户', 'user.update': '编辑用户', 'user.delete': '删除用户', 'credits.adjust': '调整积分', 'character.create': '添加角色', 'character.update': '编辑角色', 'character.delete': '删除角色', 'character.cover.upload': '上传角色封面', 'character.cover.generate': '生成角色封面', 'model.create': '添加模型', 'model.update': '编辑模型', 'model.delete': '删除模型', 'model.test': '测试模型连接', 'model.discover': '拉取模型列表', 'plan.create': '添加套餐', 'plan.update': '编辑套餐', 'plan.delete': '删除套餐', 'payment.configure': '配置支付渠道', 'order.paid': '支付到账', 'generation.failed': '生成失败', 'generation.recovered': '回收超时生成任务' }
    const rows = await this.rows(`SELECT a.*,u.email AS target_email,c.name AS character_name,m.name AS model_name,p.name AS plan_name,o.order_no,ou.email AS order_email,ru.email AS request_email,i.prompt AS image_name,iu.email AS image_email FROM platform_audit a LEFT JOIN platform_users u ON u.id=a.target LEFT JOIN platform_characters c ON c.id=a.target LEFT JOIN platform_models m ON m.id=a.target LEFT JOIN platform_plans p ON p.id=a.target LEFT JOIN platform_orders o ON o.id=a.target LEFT JOIN platform_users ou ON ou.id=o.user_id LEFT JOIN platform_requests r ON r.request_key=a.target LEFT JOIN platform_users ru ON ru.id=r.user_id LEFT JOIN platform_images i ON i.id=a.target LEFT JOIN platform_users iu ON iu.id=i.user_id ORDER BY a.created_at DESC LIMIT 1000`)
    return rows.map(row => {
      const before = parse(row.before_json); const after = parse(row.after_json)
      const account = after?.email || before?.email || row.target_email || row.order_email || row.request_email || row.image_email || ''
      const name = after?.name || before?.name || row.character_name || row.model_name || row.plan_name || row.image_name
      const targetLabel = row.action.startsWith('character.') ? '角色' + (row.action.includes('.cover.') ? '封面' : '') + '：' + (name || '已删除') : row.action.startsWith('model.') ? '模型：' + (name || (row.target === 'provider' ? '供应商' : '已删除')) : row.action.startsWith('plan.') ? '套餐：' + (name || '已删除') : row.action === 'payment.configure' ? '支付渠道' : row.order_no ? `${account} · ${row.order_no}` : account || (row.actor_id === row.target ? row.actor : '系统任务')
      return { id: row.id, actor: row.actor === 'system' ? '系统' : row.actor === 'payment-channel' ? '支付渠道' : row.actor, actorId: row.actor_id, action: row.action, actionLabel: labels[row.action] || '其他操作', target: row.target, targetLabel, targetAccount: account, before, after, reason: row.reason, createdAt: row.created_at }
    })
  }
  async overview() {
    const count = async (sql: string) => Number((await this.rows(sql))[0]?.n || 0)
    const [characters, publishedCharacters, users, conversations, messages, creditsInCirculation, pendingOrders, recentLedger, provider, imageModel] = await Promise.all([
      count('SELECT count(*) AS n FROM platform_characters WHERE deleted=0'), count('SELECT count(*) AS n FROM platform_characters WHERE deleted=0 AND published=1'), count("SELECT count(*) AS n FROM platform_users WHERE status!='deleted' AND role='user'"), count('SELECT count(*) AS n FROM platform_conversations WHERE deleted=0'), count('SELECT count(*) AS n FROM platform_messages'), count("SELECT coalesce(sum(balance+frozen),0) AS n FROM platform_users WHERE status!='deleted'"), count("SELECT count(*) AS n FROM platform_orders WHERE status='pending'"), this.ledgers(), this.provider(), this.models(),
    ])
    return { characters, publishedCharacters, users, conversations, messages, creditsInCirculation, pendingOrders, recentLedger: recentLedger.slice(0, 8), providerConfigured: !!(provider?.apiKeyConfigured && provider.enabled), database: this.db.backend, imageConfigured: imageModel.some(item => item.task === 'image' && item.isDefault && item.enabled && item.apiKeyConfigured), paymentConfigured: !!(await this.paymentConfig()).configured }
  }
  async conversations(actor: Actor) { return (await this.rows('SELECT c.*,ch.name AS character_name,ch.image AS image,(SELECT count(*) FROM platform_messages m WHERE m.conversation_id=c.id) AS message_count FROM platform_conversations c JOIN platform_characters ch ON ch.id=c.character_id WHERE c.user_id=? AND c.deleted=0 ORDER BY c.pinned DESC,c.updated_at DESC', [actor.id])).map(row => ({ id: row.id, title: row.title, characterId: row.character_id, characterName: row.character_name, image: row.image, preview: row.preview, updatedAt: row.updated_at, unread: 0, archived: !!row.archived, pinned: !!row.pinned, messageCount: Number(row.message_count) })) }
  private async conversation(actor: Actor, id: string) { const row = (await this.rows('SELECT * FROM platform_conversations WHERE id=? AND user_id=? AND deleted=0', [id, actor.id]))[0]; if (!row) fail(404, '聊天不存在'); return row }
  async messages(actor: Actor, id: string) { await this.conversation(actor, id); return (await this.rows('SELECT * FROM platform_messages WHERE conversation_id=? ORDER BY sequence', [id])).map(row => ({ id: row.id, role: row.role, content: row.content, credits: Number(row.credits), usage: parse(row.usage_json), createdAt: row.created_at })) }
  async createConversation(actor: Actor, characterId: string) {
    return this.tx(async q => { await this.activeUser(q, actor.id); const ch = (await q('SELECT * FROM platform_characters WHERE id=? AND published=1 AND deleted=0', [characterId]))[0]; if (!ch) fail(404, '角色不存在或已下架'); const id = randomUUID(); const created = now(); await q('INSERT INTO platform_conversations(id,user_id,character_id,title,preview,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [id, actor.id, ch.id, ch.name, ch.opening, created, created]); if (ch.opening) await q('INSERT INTO platform_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)', [randomUUID(), id, 'assistant', ch.opening, created]); return { id } })
  }
  async updateConversation(actor: Actor, id: string, body: any) { await this.conversation(actor, id); const updates = Object.entries(body).filter(([key]) => ['title', 'archived', 'pinned'].includes(key)); if (!updates.length) fail(400, '未提供修改内容'); for (const [key, value] of updates) { const v = key === 'title' ? text(value, '标题', 160) : +bool(value, key); await this.rows(`UPDATE platform_conversations SET ${key}=?,updated_at=? WHERE id=? AND user_id=? AND deleted=0`, [v, now(), id, actor.id]) }; return (await this.conversations(actor)).find(row => row.id === id) }
  async deleteConversation(actor: Actor, id: string) { await this.conversation(actor, id); await this.rows('UPDATE platform_conversations SET deleted=1 WHERE id=? AND user_id=?', [id, actor.id]); return { success: true } }
  private async reserve(actor: Actor, key: string, payload: string, credits: number) {
    return this.tx(async q => {
      await this.activeUser(q, actor.id)
      // Account row is the common lock for retries, adjustments and settlement.
      if (this.db.backend === 'PostgreSQL') await q('SELECT id FROM platform_users WHERE id=? FOR UPDATE', [actor.id])
      const previous = (await q('SELECT * FROM platform_requests WHERE request_key=?', [key]))[0]
      if (previous) { if (previous.payload !== payload) fail(409, '重复请求的内容不一致'); if (previous.status === 'completed') return { duplicate: true, ...parse(previous.result) }; if (previous.status === 'pending') fail(409, '请求正在生成中，请稍后重试'); await q('DELETE FROM platform_requests WHERE request_key=?', [key]) }
      if (Number((await q("SELECT count(*) AS n FROM platform_requests WHERE user_id=? AND status='pending'", [actor.id]))[0].n) >= 3) fail(429, '当前生成任务过多，请等待已有任务完成')
      const updated = (await q("UPDATE platform_users SET balance=balance-?,frozen=frozen+? WHERE id=? AND status='active' AND balance>=? RETURNING balance", [credits, credits, actor.id, credits]))[0]; if (!updated) fail(400, '积分不足')
      await q('INSERT INTO platform_requests(request_key,user_id,payload,status,reserved,created_at) VALUES(?,?,?,\'pending\',?,?)', [key, actor.id, payload, credits, now()]); return null
    })
  }
  private async refund(actor: Actor, key: string) { await this.tx(async q => { await q('SELECT id FROM platform_users WHERE id=? FOR UPDATE', [actor.id]); const request = (await q("UPDATE platform_requests SET status='failed' WHERE request_key=? AND status='pending' RETURNING reserved", [key]))[0]; if (request) { await q('UPDATE platform_users SET balance=balance+?,frozen=frozen-? WHERE id=?', [Number(request.reserved), Number(request.reserved), actor.id]); await this.audit(q, actor, 'generation.failed', key, null, { refunded: Number(request.reserved) }, '生成失败，预留积分退回') } }) }
  private async recoverExpired() {
    // Longer than every provider timeout. Recover reservations left by crashed workers.
    const cutoff = new Date(Date.now() - 600000).toISOString()
    const requests = await this.db.rows("SELECT request_key,user_id FROM platform_requests WHERE status='pending' AND created_at<?", [cutoff])
    for (const candidate of requests) await this.db.transaction(async q => { await q('SELECT id FROM platform_users WHERE id=? FOR UPDATE', [candidate.user_id]); const request = (await q("UPDATE platform_requests SET status='failed' WHERE request_key=? AND status='pending' AND created_at<? RETURNING *", [candidate.request_key, cutoff]))[0]; if (!request) return; await q('UPDATE platform_users SET balance=balance+?,frozen=frozen-? WHERE id=?', [Number(request.reserved), Number(request.reserved), request.user_id]); await this.audit(q, { id: 'system', email: 'system', role: 'system' }, 'generation.recovered', request.request_key, null, { refunded: Number(request.reserved) }, '回收超时未结算请求') })
  }
  private async settle(q: Query, actor: Actor, key: string, charge: number, reference: string, type: string, result: any) {
    await q('SELECT id FROM platform_users WHERE id=? FOR UPDATE', [actor.id])
    const request = (await q("SELECT * FROM platform_requests WHERE request_key=? AND status='pending'", [key]))[0]; if (!request) fail(409, '请求已经结算或取消')
    const reserved = Number(request.reserved); const difference = charge - reserved
    const row = (await q("UPDATE platform_users SET balance=balance-?,frozen=frozen-? WHERE id=? AND status='active' AND balance>=? RETURNING balance", [difference, reserved, actor.id, Math.max(0, difference)]))[0]; if (!row) fail(400, '积分不足，无法结算实际用量')
    result.balance = Number(row.balance); await this.writeLedger(q, actor.id, type, -charge, result.balance, reference, type === 'usage' ? '聊天实际 Token 用量' : '生成图片', key)
    await q("UPDATE platform_requests SET status='completed',result=? WHERE request_key=?", [json(result), key]); return result
  }
  async sendMessage(actor: Actor, id: string, content: string, clientMessageId: string, stream?: ChatStream) {
    text(clientMessageId, '消息请求 ID', 128); const key = `chat:${actor.id}:${id}:${clientMessageId}`
    const clean = text(content, '消息', 6000); const payload = json({ content: clean })
    const active = this.inFlight.get(key); if (active) { if (stream) fail(409, '请求正在生成中，请稍后重试'); const result = await active; const stored = (await this.rows('SELECT payload FROM platform_requests WHERE request_key=?', [key]))[0]; if (stored?.payload !== payload) fail(409, '重复请求内容不同'); return { ...result, duplicate: true } }
    const operation = this.generateMessage(actor, id, clean, key, payload, stream); this.inFlight.set(key, operation)
    try { return await operation } finally { this.inFlight.delete(key) }
  }
  async messageRequest(actor: Actor, id: string, clientMessageId: string) {
    await this.conversation(actor, id); text(clientMessageId, '消息请求 ID', 128)
    const request = (await this.rows('SELECT status,result FROM platform_requests WHERE request_key=? AND user_id=?', [`chat:${actor.id}:${id}:${clientMessageId}`, actor.id]))[0]
    return request ? { status: request.status, ...(request.status === 'completed' ? { result: parse(request.result) } : {}) } : { status: 'missing' }
  }
  private async generateMessage(actor: Actor, id: string, content: string, key: string, payload: string, stream?: ChatStream) {
    const chat = await this.conversation(actor, id); if (chat.archived) fail(400, '请先恢复归档聊天')
    const completed = (await this.rows("SELECT * FROM platform_requests WHERE request_key=? AND status='completed'", [key]))[0]
    if (completed) { if (completed.payload !== payload) fail(409, '重复请求的内容不一致'); return { ...parse(completed.result), balance: (await this.me(actor)).balance, duplicate: true } }
    const ch = await this.getCharacter(chat.character_id, false); const pricing = await this.configuredModel('chat')
    stream?.signal.throwIfAborted()
    const prior = await this.reserve(actor, key, payload, ch.cost); if (prior) return prior
    try {
      stream?.signal.throwIfAborted()
      const history = await this.messages(actor, id)
      const providerError = (error: any): never => {
        const detail = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '供应商返回生成错误'
        const safeDetail = detail.replaceAll(decrypt(pricing.key_cipher), '[密钥已隐藏]').replace(/sk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]').slice(0, 300)
        return fail(502, `聊天供应商拒绝了生成请求：${safeDetail}。请管理员检查模型和渠道可用性，预留积分已退回`)
      }
      const meta = (await this.rows('SELECT * FROM platform_character_meta WHERE character_id=?', [ch.id]))[0]
      const state = (await this.rows('SELECT * FROM platform_conversation_state WHERE conversation_id=?', [id]))[0]
      const memories = await this.rows('SELECT category,title,content FROM platform_knowledge WHERE owner_id=? AND (character_id=? OR character_id IS NULL) ORDER BY pinned DESC,importance DESC,updated_at DESC LIMIT 30', [actor.id, ch.id])
      const persona = state?.persona_id ? (await this.rows('SELECT content FROM platform_personas WHERE id=? AND user_id=?', [state.persona_id, actor.id]))[0] : (await this.rows('SELECT content FROM platform_personas WHERE user_id=? AND is_default=1 LIMIT 1', [actor.id]))[0]
      const worldBook = meta?.world_book ? parse(meta.world_book) : []
      const intelligence = [meta?.system_prompt, meta?.personality && `性格：${meta.personality}`, meta?.scenario && `场景：${meta.scenario}`, worldBook.length && `世界书：${JSON.stringify(worldBook).slice(0, 16000)}`, memories.length && `长期记忆：${memories.map(item => `${item.category}/${item.title}: ${item.content}`).join('\n')}`, persona?.content && `用户 Persona：${persona.content}`, state?.director_note && `导演指令：${state.director_note}`, state && `当前关系值：${state.relationship}；状态：${state.status_json}`].filter(Boolean).join('\n')
      const response = await generateChat({ baseUrl: pricing.base_url, apiKey: decrypt(pricing.key_cipher), model: pricing.model, messages: [{ role: 'system', content: `扮演角色「${ch.name}」。${ch.description}。${intelligence}。保持沉浸式角色扮演。围绕用户当下的问题自然聊天，默认用一至三句简短回应，不主动写长篇旁白或重复开场白。只有用户明确要求故事、详细解释或长文时才展开。` }, ...history.slice(-20).map(item => ({ role: item.role, content: item.content })), { role: 'user', content }] }, stream ? { stream: true, signal: stream.signal } : undefined)
      if (!response.ok) { const error = await response.json().catch(() => null); providerError(error?.error || `HTTP ${response.status}`) }
      let data: any
      // SillyTavern pipes upstream SSE without copying its Content-Type header.
      const isStream = response.headers.get('content-type')?.includes('text/event-stream') || (process.env.AI_ENGINE !== 'direct' && !response.headers.get('content-type'))
      if (stream && isStream && response.body) {
        let reply = ''; let usage: any; let finished = false; let phase = ''
        for await (const frame of readSse(response.body)) {
          stream.signal.throwIfAborted()
          if (frame.data === '[DONE]') { finished = true; break }
          const chunk = JSON.parse(frame.data)
          if (chunk.error) providerError(chunk.error)
          if (chunk.usage) usage = chunk.usage
          const delta = chunk.choices?.find((choice: any) => choice.index === 0 || choice.index === undefined)?.delta
          if (!reply && phase !== 'thinking' && (delta?.reasoning_content || delta?.reasoning)) { phase = 'thinking'; await stream.phase?.('thinking') }
          const text = delta?.content
          if (typeof text === 'string' && text) { if (phase !== 'responding') { phase = 'responding'; await stream.phase?.('responding') }; reply += text; if (reply.length > 200000) fail(502, '回复超过长度限制，已取消扣费'); await stream.delta(text) }
        }
        if (!finished) fail(502, '回复流意外中断，未保存本次回复，积分已退回')
        data = { choices: [{ message: { content: reply } }], usage }
      } else {
        data = await response.json()
        if (data.error) providerError(data.error)
        if (stream) fail(502, '供应商没有返回流式数据，请管理员检查渠道是否支持流式输出，积分已退回')
      }
      const reply = data.choices?.[0]?.message?.content
      if (typeof reply !== 'string' || !reply.trim()) fail(502, 'AI 返回了空回复')
      // Never estimate billable tokens when the provider omitted actual usage.
      if (!Number.isInteger(data.usage?.prompt_tokens) || !Number.isInteger(data.usage?.completion_tokens)) fail(502, '供应商未返回实际 Token 用量，已取消扣费')
      const usage: Usage = { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? data.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: data.usage.prompt_tokens_details?.cache_write_tokens ?? data.usage.cache_creation_input_tokens ?? 0, source: 'provider' }
      const user = await this.me(actor); const memberPlan = (await this.plans()).find(item => item.type === 'membership' && item.name === user.membership && item.enabled)
      const chargedCredits = calculateCharge(usage, model(pricing), ch.cost, memberPlan?.discount ?? 1)
      const billedUsage = { ...usage, modelId: pricing.id, model: pricing.model, pricing: model(pricing), discount: memberPlan?.discount ?? 1 }
      return await this.tx(async q => {
        stream?.signal.throwIfAborted()
        const activeChat = (await q('SELECT id FROM platform_conversations WHERE id=? AND deleted=0 AND archived=0', [id]))[0]; if (!activeChat) fail(409, '聊天已删除或归档')
        const messageId = randomUUID(); const stamp = now(); const result = { reply, chargedCredits, messageId, usage: billedUsage, balance: 0 }
        await this.settle(q, actor, key, chargedCredits, messageId, 'usage', result)
        await q('INSERT INTO platform_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)', [randomUUID(), id, 'user', content, stamp])
        const task = (await q("SELECT id FROM platform_tasks WHERE code='chat-3' AND enabled=1"))[0]
        if (task) await q('INSERT INTO platform_user_tasks(user_id,task_id,progress,day,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(user_id,task_id,day) DO UPDATE SET progress=platform_user_tasks.progress+1,updated_at=excluded.updated_at', [actor.id, task.id, stamp.slice(0, 10), stamp])
        await q('INSERT INTO platform_messages(id,conversation_id,role,content,credits,usage_json,created_at) VALUES(?,?,?,?,?,?,?)', [messageId, id, 'assistant', reply, chargedCredits, json(billedUsage), new Date(Date.now() + 1).toISOString()])
        await q('UPDATE platform_conversations SET preview=?,updated_at=? WHERE id=?', [reply.slice(0, 160), stamp, id]); return result
      })
    } catch (error) { await this.refund(actor, key); if (stream?.signal.aborted) fail(499, '已停止生成，未保存本次回复，预留积分已退回'); if (error instanceof DomainError) throw error; fail(502, '生成失败，积分已退回，请检查供应商配置') }
  }
  async images(actor: Actor) { return (await this.rows('SELECT * FROM platform_images WHERE user_id=? AND deleted=0 ORDER BY created_at DESC', [actor.id])).map(row => ({ id: row.id, url: row.url, prompt: row.prompt, conversationId: row.conversation_id, favorite: !!row.favorite, credits: Number(row.credits), createdAt: row.created_at })) }
  async uploadImage(actor: Actor, body: any) {
    const prompt = text(body.name, '图片名称', 200)
    if (typeof body.base64 !== 'string' || body.base64.length > 12000000 || !/^[A-Za-z0-9+/=]+$/.test(body.base64)) fail(400, '图片数据无效')
    const imageUrl = imageData(Buffer.from(body.base64, 'base64')); const id = randomUUID()
    await this.rows('INSERT INTO platform_images(id,user_id,url,prompt,credits,created_at) VALUES(?,?,?,?,0,?)', [id, actor.id, imageUrl, prompt, now()]); return { id, url: imageUrl, prompt, credits: 0 }
  }
  async updateImage(actor: Actor, id: string, favorite: boolean) { bool(favorite, '收藏'); const row = (await this.rows('UPDATE platform_images SET favorite=? WHERE id=? AND user_id=? AND deleted=0 RETURNING id', [+favorite, id, actor.id]))[0]; if (!row) fail(404, '图片不存在'); return { favorite } }
  async deleteImage(actor: Actor, id: string) { const row = (await this.rows('UPDATE platform_images SET deleted=1 WHERE id=? AND user_id=? AND deleted=0 RETURNING id', [id, actor.id]))[0]; if (!row) fail(404, '图片不存在'); return { success: true } }
  async generateImage(actor: Actor, body: any) {
    const prompt = text(body.prompt, '图片描述', 2000); const requestId = text(body.requestId, '请求 ID', 128); const chat = await this.conversation(actor, body.conversationId); const pricing = await this.configuredModel('image'); const key = `image:${actor.id}:${requestId}`
    const prior = await this.reserve(actor, key, json({ prompt, conversationId: chat.id }), Number(pricing.image_rate)); if (prior) return prior
    try {
      const response = await fetch(normalizeProviderBaseUrl(pricing.base_url) + '/images/generations', { method: 'POST', headers: { authorization: 'Bearer ' + decrypt(pricing.key_cipher), 'content-type': 'application/json' }, body: json({ model: pricing.model, prompt, n: 1, size: '1024x1024' }), signal: AbortSignal.timeout(120000) })
      if (!response.ok) fail(502, `生图供应商返回 HTTP ${response.status}`)
      const data = await response.json() as any; const imageUrl = await persistProviderImage(data.data?.[0])
      return await this.tx(async q => { const id = randomUUID(); const chargedCredits = Number(pricing.image_rate); const result = { id, url: imageUrl, prompt, conversationId: chat.id, chargedCredits, balance: 0 }; await this.settle(q, actor, key, chargedCredits, id, 'image_usage', result); await q('INSERT INTO platform_images(id,user_id,conversation_id,url,prompt,credits,created_at) VALUES(?,?,?,?,?,?,?)', [id, actor.id, chat.id, imageUrl, prompt, chargedCredits, now()]); await q('INSERT INTO platform_messages(id,conversation_id,role,content,credits,created_at) VALUES(?,?,?,?,?,?)', [randomUUID(), chat.id, 'assistant', '已生成图片：' + prompt, chargedCredits, now()]); return result })
    } catch (error) { await this.refund(actor, key); if (error instanceof DomainError) throw error; fail(502, '图片生成失败，积分已退回') }
  }
  async plans(publicOnly = false) { return (await this.rows(`SELECT * FROM platform_plans ${publicOnly ? 'WHERE enabled=1' : ''} ORDER BY price`)).map(plan) }
  async savePlan(actor: Actor, id: string | null, body: any) {
    return this.tx(async q => {
      const before = id ? (await q('SELECT * FROM platform_plans WHERE id=?', [id]))[0] : null; if (id && !before) fail(404, '套餐不存在')
      const value = { ...(before ? plan(before) : { credits: 0, days: 0, discount: 1, enabled: true }), ...body }
      const name = text(value.name, '套餐名称', 80); const type = choice(value.type, ['recharge', 'membership'], '套餐类型'); const price = number(value.price, '价格（分）', 1, 100000000); const credits = number(value.credits, '积分', 0, 10000000); const days = number(value.days, '会员天数', type === 'membership' ? 1 : 0, 3650); const discount = number(value.discount, '折扣', 0.01, 1, false); const enabled = bool(value.enabled, '状态'); const target = id || randomUUID()
      if (type === 'recharge' && credits < 1) fail(400, '充值套餐积分必须大于零')
      if (id) await q('UPDATE platform_plans SET name=?,type=?,price=?,credits=?,days=?,discount=?,enabled=? WHERE id=?', [name, type, price, credits, days, discount, +enabled, id])
      else await q('INSERT INTO platform_plans(id,name,type,price,credits,days,discount,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [target, name, type, price, credits, days, discount, +enabled, now()])
      const result = { id: target, name, type, price, credits, days, discount, enabled }; await this.audit(q, actor, id ? 'plan.update' : 'plan.create', target, before ? plan(before) : null, result); return result
    })
  }
  async deletePlan(actor: Actor, id: string) { return this.tx(async q => { const before = (await q('SELECT * FROM platform_plans WHERE id=?', [id]))[0]; if (!before) fail(404, '套餐不存在'); if ((await q('SELECT id FROM platform_orders WHERE plan_id=?', [id])).length) fail(409, '套餐已有订单，请使用下架保留历史'); await q('DELETE FROM platform_plans WHERE id=?', [id]); await this.audit(q, actor, 'plan.delete', id, plan(before), null); return { success: true } }) }
  async paymentConfig() { const row = (await this.rows("SELECT value FROM platform_settings WHERE key='payment'"))[0]; const config = row ? parse(row.value) : {}; return { gatewayUrl: config.gatewayUrl || '', notifyUrl: config.notifyUrl || '', merchantId: config.merchantId || '', secretConfigured: !!config.secretCipher, configured: !!(config.gatewayUrl && config.notifyUrl && config.merchantId && config.secretCipher) } }
  async savePayment(actor: Actor, body: any) { return this.tx(async q => { const old = (await q("SELECT value FROM platform_settings WHERE key='payment'"))[0]; const value = old ? parse(old.value) : {}; const gatewayUrl = url(body.gatewayUrl ?? value.gatewayUrl, '支付地址'); const notifyUrl = url(body.notifyUrl ?? value.notifyUrl, '回调地址'); const merchantId = text(body.merchantId ?? value.merchantId, '商户号', 160); const secretCipher = body.secret?.trim() ? encrypt(text(body.secret, '签名密钥', 1000)) : value.secretCipher || ''; await q("INSERT INTO platform_settings(key,value) VALUES('payment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [json({ gatewayUrl, notifyUrl, merchantId, secretCipher })]); await this.audit(q, actor, 'payment.configure', 'payment', redact(value), { gatewayUrl, notifyUrl, merchantId, configured: !!secretCipher }); return { success: true } }) }
  async orders(actor?: Actor) { return (await this.rows(`SELECT o.*,u.email FROM platform_orders o JOIN platform_users u ON u.id=o.user_id ${actor ? 'WHERE o.user_id=?' : ''} ORDER BY o.created_at DESC`, actor ? [actor.id] : [])).map(order) }
  async createOrder(actor: Actor, planId: string) {
    const config = (await this.rows("SELECT value FROM platform_settings WHERE key='payment'"))[0]; const payment = config ? parse(config.value) : null
    if (!payment?.secretCipher || !payment.gatewayUrl || !payment.notifyUrl) fail(503, '支付渠道尚未接入，请联系管理员')
    const selected = (await this.plans(true)).find(item => item.id === planId) ?? fail(404, '套餐不存在或已下架')
    const id = randomUUID(); const orderNo = 'XY' + Date.now() + randomBytes(5).toString('hex')
    await this.rows('INSERT INTO platform_orders(id,order_no,user_id,plan_id,plan_json,amount,credits,type,status,created_at) VALUES(?,?,?,?,?,?,?,?,\'creating\',?)', [id, orderNo, actor.id, selected.id, json(selected), selected.price, selected.credits, selected.type, now()])
    try {
      const timestamp = String(Date.now()); const signature = createHmac('sha256', decrypt(payment.secretCipher)).update(`${payment.merchantId}|${orderNo}|${selected.price}|${timestamp}`).digest('hex')
      const response = await fetch(payment.gatewayUrl + '/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ merchantId: payment.merchantId, orderNo, amount: selected.price, currency: 'CNY', description: selected.name, notifyUrl: payment.notifyUrl, timestamp, signature }), signal: AbortSignal.timeout(20000) })
      if (!response.ok) fail(502, '支付渠道创建订单失败')
      const data = await response.json() as any; const paymentUrl = url(data.paymentUrl, '支付跳转地址'); await this.rows("UPDATE platform_orders SET payment_url=?,status='pending' WHERE id=? AND status='creating'", [paymentUrl, id]); return { id, orderNo, paymentUrl, amount: selected.price }
    } catch (error) { await this.rows("UPDATE platform_orders SET status='failed' WHERE id=? AND status='creating'", [id]); if (error instanceof DomainError) throw error; fail(502, '支付渠道无法连接，未增加积分') }
  }
  async cancelOrder(actor: Actor, id: string) { const row = (await this.rows("UPDATE platform_orders SET status='cancelled' WHERE id=? AND user_id=? AND status='pending' RETURNING id", [id, actor.id]))[0]; if (!row) fail(409, '订单不存在或无法取消'); return { success: true } }
  async paymentCallback(body: any) {
    const row = (await this.rows("SELECT value FROM platform_settings WHERE key='payment'"))[0]; const config = row ? parse(row.value) : null; if (!config?.secretCipher) fail(503, '支付渠道未配置')
    const orderNo = text(body.orderNo, '订单号', 128); const eventId = text(body.eventId, '支付事件 ID', 128); const amount = number(body.amount, '金额', 1, 100000000); const status = choice(body.status, ['paid'], '支付状态'); const timestamp = text(body.timestamp, '时间戳', 80)
    if (!Number.isFinite(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > 300000) fail(401, '支付通知已过期')
    const expected = createHmac('sha256', decrypt(config.secretCipher)).update(`${orderNo}|${eventId}|${amount}|${status}|${timestamp}`).digest('hex'); const supplied = Buffer.from(typeof body.signature === 'string' ? body.signature : '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, Buffer.from(expected))) fail(401, '支付通知签名无效')
    return this.tx(async q => {
      const orderRow = (await q('SELECT * FROM platform_orders WHERE order_no=?' + (this.db.backend === 'PostgreSQL' ? ' FOR UPDATE' : ''), [orderNo]))[0]; if (!orderRow) fail(404, '订单不存在'); if (Number(orderRow.amount) !== amount) fail(400, '支付金额不匹配'); if (orderRow.status === 'paid') { if (orderRow.event_id !== eventId) fail(409, '订单已由其他支付事件结算'); return { success: true, duplicate: true } }
      // A verified late payment must still credit an order cancelled locally.
      if (!['pending', 'creating', 'cancelled', 'failed'].includes(orderRow.status)) fail(409, '订单状态无法入账'); if ((await q('SELECT id FROM platform_orders WHERE event_id=?', [eventId])).length) fail(409, '支付事件已使用')
      const user = await this.activeUser(q, orderRow.user_id); const selected = parse(orderRow.plan_json)
      const updated = (await q('UPDATE platform_users SET balance=balance+? WHERE id=? RETURNING balance', [Number(orderRow.credits), user.id]))[0]
      if (selected.type === 'membership') { const starts = user.membership_until && user.membership_until > now() && user.membership === selected.name ? Date.parse(user.membership_until) : Date.now(); await q('UPDATE platform_users SET membership=?,membership_until=? WHERE id=?', [selected.name, new Date(starts + selected.days * 86400000).toISOString(), user.id]) }
      await this.writeLedger(q, user.id, 'recharge', Number(orderRow.credits), Number(updated.balance), orderRow.id, '支付成功：' + selected.name, 'payment:' + eventId)
      const invite = (await q('SELECT invited_by FROM platform_invites WHERE user_id=?', [user.id]))[0]
      if (invite?.invited_by) await q('INSERT INTO platform_commissions(id,beneficiary_id,source_user_id,order_id,amount,created_at) VALUES(?,?,?,?,?,?)', [randomUUID(), invite.invited_by, user.id, orderRow.id, Math.floor(Number(orderRow.amount) * 0.1), now()])
      await q("UPDATE platform_orders SET status='paid',event_id=?,paid_at=? WHERE id=?", [eventId, now(), orderRow.id]); await this.audit(q, { id: 'payment', email: config.merchantId, role: 'system' }, 'order.paid', orderRow.id, { status: orderRow.status }, { status: 'paid', amount, credits: Number(orderRow.credits) }); return { success: true }
    })
  }

  // Character intelligence and chat control APIs.
  async characterMeta(id: string) {
    await this.getCharacter(id, false)
    const row = (await this.rows('SELECT * FROM platform_character_meta WHERE character_id=?', [id]))[0]
    return row ? { characterId: id, systemPrompt: row.system_prompt, personality: row.personality, scenario: row.scenario, alternateGreetings: parse(row.alternate_greetings), worldBook: parse(row.world_book), extensions: parse(row.extensions) } : { characterId: id, systemPrompt: '', personality: '', scenario: '', alternateGreetings: [], worldBook: [], extensions: {} }
  }
  async saveCharacterMeta(actor: Actor, id: string, body: any) {
    await this.getCharacter(id, false)
    if (!['admin', 'operator'].includes(actor.role)) { const owner = (await this.rows('SELECT creator_id FROM platform_character_meta WHERE character_id=?', [id]))[0]; if (owner?.creator_id && owner.creator_id !== actor.id) fail(403, '只能编辑自己创建的角色') }
    const value = { systemPrompt: String(body.systemPrompt || '').slice(0, 20000), personality: String(body.personality || '').slice(0, 12000), scenario: String(body.scenario || '').slice(0, 12000), alternateGreetings: Array.isArray(body.alternateGreetings) ? body.alternateGreetings.slice(0, 20) : [], worldBook: Array.isArray(body.worldBook) ? body.worldBook.slice(0, 200) : [], extensions: body.extensions && typeof body.extensions === 'object' ? body.extensions : {} }
    await this.rows('INSERT INTO platform_character_meta(character_id,creator_id,system_prompt,personality,scenario,alternate_greetings,world_book,extensions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET system_prompt=excluded.system_prompt,personality=excluded.personality,scenario=excluded.scenario,alternate_greetings=excluded.alternate_greetings,world_book=excluded.world_book,extensions=excluded.extensions,updated_at=excluded.updated_at', [id, actor.id, value.systemPrompt, value.personality, value.scenario, json(value.alternateGreetings), json(value.worldBook), json(value.extensions), now(), now()])
    return this.characterMeta(id)
  }
  async worldBooks(actor: Actor, characterId?: string) { const rows = await this.rows('SELECT * FROM platform_world_books WHERE owner_id=? ' + (characterId ? 'AND character_id=? ' : '') + 'ORDER BY updated_at DESC', characterId ? [actor.id, characterId] : [actor.id]); return rows.map(row => ({ id: row.id, characterId: row.character_id, name: row.name, description: row.description, entries: parse(row.entries), visibility: row.visibility, createdAt: row.created_at, updatedAt: row.updated_at })) }
  async saveWorldBook(actor: Actor, body: any, id?: string) { const name = text(body.name, '世界书名称', 120); const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : []; const visibility = choice(body.visibility || 'private', ['private', 'public'], '可见性'); const characterId = body.characterId ? text(body.characterId, '角色 ID', 128) : null; if (characterId) await this.getCharacter(characterId, false); const target = id || randomUUID(); await this.rows(id ? 'UPDATE platform_world_books SET name=?,description=?,entries=?,visibility=?,character_id=?,updated_at=? WHERE id=? AND owner_id=?' : 'INSERT INTO platform_world_books(id,owner_id,character_id,name,description,entries,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id ? [name, String(body.description || '').slice(0, 1000), json(entries), visibility, characterId, now(), id, actor.id] : [target, actor.id, characterId, name, String(body.description || '').slice(0, 1000), json(entries), visibility, now(), now()]); return (await this.worldBooks(actor)).find(item => item.id === target) || { id: target, name, entries, visibility } }
  async deleteWorldBook(actor: Actor, id: string) { const row = (await this.rows('DELETE FROM platform_world_books WHERE id=? AND owner_id=? RETURNING id', [id, actor.id]))[0]; if (!row) fail(404, '世界书不存在'); return { success: true } }
  async knowledge(actor: Actor, characterId?: string) { const rows = await this.rows('SELECT * FROM platform_knowledge WHERE owner_id=? ' + (characterId ? 'AND character_id=? ' : '') + 'ORDER BY pinned DESC,importance DESC,updated_at DESC', characterId ? [actor.id, characterId] : [actor.id]); return rows.map(row => ({ id: row.id, characterId: row.character_id, category: row.category, title: row.title, content: row.content, importance: Number(row.importance), pinned: !!row.pinned, createdAt: row.created_at, updatedAt: row.updated_at })) }
  async saveKnowledge(actor: Actor, body: any, id?: string) { const title = text(body.title, '记忆标题', 160); const content = text(body.content, '记忆内容', 5000); const characterId = body.characterId ? text(body.characterId, '角色 ID', 128) : null; const importance = number(body.importance ?? 3, '重要性', 1, 5); const pinned = !!body.pinned; const target = id || randomUUID(); await this.rows(id ? 'UPDATE platform_knowledge SET title=?,content=?,category=?,importance=?,pinned=?,character_id=?,updated_at=? WHERE id=? AND owner_id=?' : 'INSERT INTO platform_knowledge(id,owner_id,character_id,category,title,content,importance,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id ? [title, content, String(body.category || '故事').slice(0, 40), importance, +pinned, characterId, now(), id, actor.id] : [target, actor.id, characterId, String(body.category || '故事').slice(0, 40), title, content, importance, +pinned, now(), now()]); return (await this.knowledge(actor, characterId || undefined)).find(item => item.id === target) }
  async deleteKnowledge(actor: Actor, id: string) { const row = (await this.rows('DELETE FROM platform_knowledge WHERE id=? AND owner_id=? RETURNING id', [id, actor.id]))[0]; if (!row) fail(404, '记忆不存在'); return { success: true } }
  async personas(actor: Actor) { return (await this.rows('SELECT * FROM platform_personas WHERE user_id=? ORDER BY is_default DESC,updated_at DESC', [actor.id])).map(row => ({ id: row.id, name: row.name, content: row.content, isDefault: !!row.is_default, createdAt: row.created_at, updatedAt: row.updated_at })) }
  async savePersona(actor: Actor, body: any, id?: string) { const name = text(body.name, 'Persona 名称', 80); const content = text(body.content, 'Persona 内容', 6000); const target = id || randomUUID(); return this.tx(async q => { if (body.isDefault) await q('UPDATE platform_personas SET is_default=0 WHERE user_id=?', [actor.id]); if (id) await q('UPDATE platform_personas SET name=?,content=?,is_default=?,updated_at=? WHERE id=? AND user_id=?', [name, content, +(!!body.isDefault), now(), id, actor.id]); else await q('INSERT INTO platform_personas(id,user_id,name,content,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [target, actor.id, name, content, +(!!body.isDefault), now(), now()]); return (await this.personas(actor)).find(item => item.id === target) }) }
  async deletePersona(actor: Actor, id: string) { const row = (await this.rows('DELETE FROM platform_personas WHERE id=? AND user_id=? RETURNING id', [id, actor.id]))[0]; if (!row) fail(404, 'Persona 不存在'); return { success: true } }
  async conversationState(actor: Actor, id: string) { await this.conversation(actor, id); const row = (await this.rows('SELECT * FROM platform_conversation_state WHERE conversation_id=?', [id]))[0]; return row ? { conversationId: id, relationship: Number(row.relationship), status: parse(row.status_json), directorNote: row.director_note, personaId: row.persona_id } : { conversationId: id, relationship: 0, status: {}, directorNote: '', personaId: null } }
  async saveConversationState(actor: Actor, id: string, body: any) { await this.conversation(actor, id); const relationship = number(body.relationship ?? 0, '关系值', -100, 100); const status = body.status && typeof body.status === 'object' ? body.status : {}; const directorNote = String(body.directorNote || '').slice(0, 5000); const personaId = body.personaId || null; await this.rows('INSERT INTO platform_conversation_state(conversation_id,relationship,status_json,director_note,persona_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET relationship=excluded.relationship,status_json=excluded.status_json,director_note=excluded.director_note,persona_id=excluded.persona_id,updated_at=excluded.updated_at', [id, relationship, json(status), directorNote, personaId, now()]); return this.conversationState(actor, id) }
  async undoLastRound(actor: Actor, id: string) { await this.conversation(actor, id); return this.tx(async q => { const rows = await q('SELECT id,role FROM platform_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 2', [id]); if (!rows.length) fail(400, '没有可撤回的消息'); await q('DELETE FROM platform_messages WHERE id = ANY(?::text[])', [rows.map(row => row.id)]); await q('UPDATE platform_conversations SET preview=(SELECT content FROM platform_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1),updated_at=? WHERE id=?', [id, now(), id]); return { success: true } }) }
  async refreshGreeting(actor: Actor, id: string) { const chat = await this.conversation(actor, id); const meta = await this.characterMeta(chat.character_id); const greeting = meta.alternateGreetings?.[Math.floor(Math.random() * Math.max(1, meta.alternateGreetings.length))] || (await this.getCharacter(chat.character_id, false)).opening; if (!greeting) fail(400, '该角色没有可用开场白'); await this.rows('INSERT INTO platform_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)', [randomUUID(), id, 'assistant', String(greeting), now()]); return { greeting } }
  async storyOptions(actor: Actor, id: string) { const state = await this.conversationState(actor, id); await this.messages(actor, id); return { options: ['回应并追问细节', '观察周围环境，寻找新的线索', '暂时停下脚步，和角色坦诚交流'], relationship: state.relationship } }
  async statusBar(actor: Actor, id: string) { const state = await this.conversationState(actor, id); return { relationship: state.relationship, status: state.status, label: state.relationship >= 60 ? '亲密' : state.relationship >= 20 ? '友好' : state.relationship <= -20 ? '疏离' : '普通' } }
  async social(actor: Actor, characterId: string) { const counts = (await this.rows('SELECT count(*) FILTER (WHERE 1=1) AS likes FROM platform_social_likes WHERE character_id=?', [characterId]))[0]; const comments = await this.rows('SELECT c.*,u.name AS user_name FROM platform_comments c JOIN platform_users u ON u.id=c.user_id WHERE character_id=? ORDER BY c.created_at DESC LIMIT 100', [characterId]); const liked = !!(await this.rows('SELECT 1 FROM platform_social_likes WHERE user_id=? AND character_id=?', [actor.id, characterId])).length; return { likes: Number(counts?.likes || 0), liked, comments: comments.map(row => ({ id: row.id, content: row.content, userId: row.user_id, userName: row.user_name, createdAt: row.created_at })) } }
  async toggleLike(actor: Actor, characterId: string, liked: boolean) { await this.getCharacter(characterId, false); bool(liked, '点赞'); if (liked) await this.rows('INSERT INTO platform_social_likes(user_id,character_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [actor.id, characterId, now()]); else await this.rows('DELETE FROM platform_social_likes WHERE user_id=? AND character_id=?', [actor.id, characterId]); return this.social(actor, characterId) }
  async comment(actor: Actor, characterId: string, content: string) { await this.getCharacter(characterId, false); const clean = text(content, '评论', 1000); await this.rows('INSERT INTO platform_comments(id,user_id,character_id,content,created_at) VALUES(?,?,?,?,?)', [randomUUID(), actor.id, characterId, clean, now()]); return this.social(actor, characterId) }
  async toggleFollow(actor: Actor, userId: string, followed: boolean) { if (actor.id === userId) fail(400, '不能关注自己'); bool(followed, '关注'); if (followed) await this.rows('INSERT INTO platform_follows(follower_id,followed_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [actor.id, userId, now()]); else await this.rows('DELETE FROM platform_follows WHERE follower_id=? AND followed_id=?', [actor.id, userId]); return { followed } }
  async author(actor: Actor, userId: string) { const user = (await this.rows("SELECT id,name,created_at FROM platform_users WHERE id=? AND status='active'", [userId]))[0]; if (!user) fail(404, '作者不存在'); const chars = await this.rows('SELECT * FROM platform_characters WHERE deleted=0 AND published=1 AND id IN (SELECT character_id FROM platform_character_meta WHERE creator_id=?)', [userId]); const follows = Number((await this.rows('SELECT count(*) AS n FROM platform_follows WHERE followed_id=?', [userId]))[0]?.n || 0); return { id: user.id, name: user.name, createdAt: user.created_at, followers: follows, following: !!(await this.rows('SELECT 1 FROM platform_follows WHERE follower_id=? AND followed_id=?', [actor.id, userId])).length, characters: chars.map(character) } }
  async checkin(actor: Actor) { const day = new Date().toISOString().slice(0, 10); const existing = (await this.rows('SELECT * FROM platform_checkins WHERE user_id=? AND day=?', [actor.id, day]))[0]; if (existing) return { streak: Number(existing.streak), reward: 0, duplicate: true }; const previous = (await this.rows('SELECT streak,day FROM platform_checkins WHERE user_id=? ORDER BY day DESC LIMIT 1', [actor.id]))[0]; const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10); const streak = previous?.day === yesterday ? Number(previous.streak) + 1 : 1; const reward = Math.min(100, 10 + streak * 2); await this.tx(async q => { const updated = (await q('UPDATE platform_users SET balance=balance+? WHERE id=? RETURNING balance', [reward, actor.id]))[0]; await q('INSERT INTO platform_checkins(user_id,day,streak,reward,created_at) VALUES(?,?,?,?,?)', [actor.id, day, streak, reward, now()]); const task = (await q("SELECT id FROM platform_tasks WHERE code='daily-login'"))[0]; if (task) await q('INSERT INTO platform_user_tasks(user_id,task_id,progress,day,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(user_id,task_id,day) DO UPDATE SET progress=1,updated_at=excluded.updated_at', [actor.id, task.id, day, now()]); await this.writeLedger(q, actor.id, 'checkin', reward, Number(updated.balance), day, '每日签到', 'checkin:' + actor.id + ':' + day) }); return { streak, reward } }
  async tasks(actor: Actor) { const day = new Date().toISOString().slice(0, 10); const rows = await this.rows('SELECT t.*,coalesce(ut.progress,0) progress,coalesce(ut.claimed,0) claimed FROM platform_tasks t LEFT JOIN platform_user_tasks ut ON ut.task_id=t.id AND ut.user_id=? AND ut.day=? WHERE t.enabled=1 ORDER BY t.kind,t.id', [actor.id, day]); return rows.map(row => ({ id: row.id, code: row.code, name: row.name, description: row.description, reward: Number(row.reward), progress: Number(row.progress), claimed: !!row.claimed, target: row.code === 'chat-3' ? 3 : 1 })) }
  async claimTask(actor: Actor, id: string) { const day = new Date().toISOString().slice(0, 10); return this.tx(async q => { const row = (await q('SELECT t.*,coalesce(ut.progress,0) progress,coalesce(ut.claimed,0) claimed FROM platform_tasks t LEFT JOIN platform_user_tasks ut ON ut.task_id=t.id AND ut.user_id=? AND ut.day=? WHERE t.id=?', [actor.id, day, id]))[0]; if (!row || Number(row.progress) < (row.code === 'chat-3' ? 3 : 1) || row.claimed) fail(400, '任务尚未完成或已领取'); await q('UPDATE platform_user_tasks SET claimed=1,updated_at=? WHERE user_id=? AND task_id=? AND day=?', [now(), actor.id, id, day]); const updated = (await q('UPDATE platform_users SET balance=balance+? WHERE id=? RETURNING balance', [Number(row.reward), actor.id]))[0]; await this.writeLedger(q, actor.id, 'task_reward', Number(row.reward), Number(updated.balance), id, row.name, 'task:' + actor.id + ':' + id + ':' + day); return { reward: Number(row.reward), balance: Number(updated.balance) } }) }
  async novels(actor: Actor, mine = false) { const rows = await this.rows('SELECT n.*,u.name author_name,(SELECT count(*) FROM platform_novel_chapters c WHERE c.novel_id=n.id) chapter_count FROM platform_novels n JOIN platform_users u ON u.id=n.author_id ' + (mine ? 'WHERE n.author_id=? ' : "WHERE n.visibility='public' ") + 'ORDER BY n.updated_at DESC', mine ? [actor.id] : []); return rows.map(row => ({ id: row.id, title: row.title, summary: row.summary, cover: row.cover, tags: parse(row.tags), visibility: row.visibility, authorId: row.author_id, authorName: row.author_name, chapterCount: Number(row.chapter_count), updatedAt: row.updated_at })) }
  async saveNovel(actor: Actor, body: any, id?: string) { const title = text(body.title, '小说标题', 160); const summary = String(body.summary || '').slice(0, 2000); const visibility = choice(body.visibility || 'draft', ['draft', 'public'], '发布状态'); const target = id || randomUUID(); await this.rows(id ? 'UPDATE platform_novels SET title=?,summary=?,cover=?,tags=?,visibility=?,updated_at=? WHERE id=? AND author_id=?' : 'INSERT INTO platform_novels(id,author_id,title,summary,cover,tags,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id ? [title, summary, String(body.cover || '').slice(0, 2000), json(Array.isArray(body.tags) ? body.tags.slice(0, 20) : []), visibility, now(), id, actor.id] : [target, actor.id, title, summary, String(body.cover || '').slice(0, 2000), json(Array.isArray(body.tags) ? body.tags.slice(0, 20) : []), visibility, now(), now()]); return (await this.novels(actor, true)).find(item => item.id === target) }
  async novel(actor: Actor, id: string) { const row = (await this.rows('SELECT n.*,u.name author_name FROM platform_novels n JOIN platform_users u ON u.id=n.author_id WHERE n.id=? AND (n.visibility=\'public\' OR n.author_id=?)', [id, actor.id]))[0]; if (!row) fail(404, '小说不存在'); const chapters = await this.rows('SELECT id,number,title,content,updated_at FROM platform_novel_chapters WHERE novel_id=? ORDER BY number', [id]); return { id: row.id, title: row.title, summary: row.summary, cover: row.cover, tags: parse(row.tags), visibility: row.visibility, authorId: row.author_id, authorName: row.author_name, chapters } }
  async saveChapter(actor: Actor, novelId: string, body: any, chapterId?: string) { await this.novel(actor, novelId); const title = text(body.title, '章节标题', 160); const content = text(body.content, '章节内容', 100000); const numberValue = number(body.number, '章节序号', 1, 100000); const target = chapterId || randomUUID(); await this.rows(chapterId ? 'UPDATE platform_novel_chapters SET number=?,title=?,content=?,updated_at=? WHERE id=?' : 'INSERT INTO platform_novel_chapters(id,novel_id,number,title,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', chapterId ? [numberValue, title, content, now(), chapterId] : [target, novelId, numberValue, title, content, now(), now()]); return this.novel(actor, novelId) }
  async invite(actor: Actor) { let row = (await this.rows('SELECT * FROM platform_invites WHERE user_id=?', [actor.id]))[0]; if (!row) { row = (await this.rows('INSERT INTO platform_invites(user_id,code,created_at) VALUES(?,?,?) RETURNING *', [actor.id, 'XY' + randomBytes(4).toString('hex').toUpperCase(), now()]))[0] }; const commissions = await this.rows('SELECT * FROM platform_commissions WHERE beneficiary_id=? ORDER BY created_at DESC LIMIT 100', [actor.id]); return { code: row.code, commissions: commissions.map(item => ({ id: item.id, amount: Number(item.amount), status: item.status, createdAt: item.created_at })), total: commissions.reduce((sum, item) => sum + Number(item.amount), 0) } }
  async bindInvite(actor: Actor, code: string) { const value = text(code, '邀请码', 40).toUpperCase(); const row = (await this.rows('SELECT * FROM platform_invites WHERE code=?', [value]))[0]; if (!row || row.user_id === actor.id) fail(400, '邀请码无效'); const existing = (await this.rows('SELECT invited_by FROM platform_invites WHERE user_id=?', [actor.id]))[0]; if (existing?.invited_by) fail(409, '已经绑定过邀请人'); await this.rows('UPDATE platform_invites SET invited_by=? WHERE user_id=?', [row.user_id, actor.id]); return { success: true, inviterId: row.user_id } }
  async redeemCommission(actor: Actor) { return this.tx(async q => { const amount = Number((await q("SELECT coalesce(sum(amount),0) AS n FROM platform_commissions WHERE beneficiary_id=? AND status='available'", [actor.id]))[0].n); if (!amount) fail(400, '暂无可兑换佣金'); const updated = (await q('UPDATE platform_users SET balance=balance+? WHERE id=? RETURNING balance', [amount, actor.id]))[0]; await q("UPDATE platform_commissions SET status='redeemed',redeemed_at=? WHERE beneficiary_id=? AND status='available'", [now(), actor.id]); await this.writeLedger(q, actor.id, 'commission', amount, Number(updated.balance), actor.id, '邀请返佣兑换积分', 'commission:' + actor.id + ':' + Date.now()); return { amount, balance: Number(updated.balance) } }) }
  async miniapps(actor: Actor, characterId?: string) { const rows = await this.rows('SELECT * FROM platform_miniapps WHERE ' + (characterId ? 'character_id=? AND (published=1 OR owner_id=?)' : 'owner_id=?') + ' ORDER BY updated_at DESC', characterId ? [characterId, actor.id] : [actor.id]); return rows.map(row => ({ id: row.id, characterId: row.character_id, name: row.name, description: row.description, schema: parse(row.schema_json), published: !!row.published, updatedAt: row.updated_at })) }
  async saveMiniapp(actor: Actor, body: any, id?: string) { const characterId = text(body.characterId, '角色 ID', 128); await this.getCharacter(characterId, false); const name = text(body.name, '游戏卡名称', 120); const target = id || randomUUID(); await this.rows(id ? 'UPDATE platform_miniapps SET name=?,description=?,schema_json=?,published=?,updated_at=? WHERE id=? AND owner_id=?' : 'INSERT INTO platform_miniapps(id,character_id,owner_id,name,description,schema_json,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id ? [name, String(body.description || '').slice(0, 1000), json(body.schema || {}), +(!!body.published), now(), id, actor.id] : [target, characterId, actor.id, name, String(body.description || '').slice(0, 1000), json(body.schema || {}), +(!!body.published), now(), now()]); return (await this.miniapps(actor)).find(item => item.id === target) }
  async saveGame(actor: Actor, miniappId: string, slot: string, data: any) { text(slot, '存档槽位', 80); await this.miniapps(actor); const row = (await this.rows('SELECT id FROM platform_miniapps WHERE id=? AND (owner_id=? OR published=1)', [miniappId, actor.id]))[0]; if (!row) fail(404, '游戏卡不存在'); await this.rows('INSERT INTO platform_game_saves(id,miniapp_id,user_id,slot,data_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(miniapp_id,user_id,slot) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at', [randomUUID(), miniappId, actor.id, slot, json(data || {}), now()]); return { miniappId, slot, data } }
  async games(actor: Actor, miniappId: string) { return (await this.rows('SELECT slot,data_json,updated_at FROM platform_game_saves WHERE miniapp_id=? AND user_id=? ORDER BY updated_at DESC', [miniappId, actor.id])).map(row => ({ slot: row.slot, data: parse(row.data_json), updatedAt: row.updated_at })) }
}
