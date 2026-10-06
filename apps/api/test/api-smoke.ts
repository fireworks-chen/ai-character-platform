import 'reflect-metadata'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { Pool } from 'pg'
import { readSse } from '@ai-character/data/dist/sse'
import { NestFactory } from '@nestjs/core'
import { loadEnvironment } from '@ai-character/data'
import { AppModule } from '../src/app.module'
import { AppService } from '../src/app.service'
import { setupHttp as userHttp } from '../src/http-setup'
import { AdminApiModule } from '../../admin-api/dist/admin-api.module'
import { AdminApiService } from '../../admin-api/dist/admin-api.service'
import { setupHttp as adminHttp } from '../../admin-api/dist/http-setup'

async function main() {
  loadEnvironment()
  process.env.DATABASE_SCHEMA = 'api_test_' + process.pid
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'integration-admin@example.test'
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'IntegrationPass#123'
  process.env.AI_ENGINE = 'direct'
  let mode = 'success'; let calls = 0; let listMode = 'success'; let imageMode = 'success'; let imageCalls = 0
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    res.setHeader('content-type', 'application/json')
    const providerPath = req.url?.replace(/^\/v1(?=\/)/, '')
    if (providerPath === '/website/models') { res.setHeader('content-type', 'text/html'); return res.end('<html>provider home page</html>') }
    if (providerPath === '/models') { if (listMode === 'failure') { res.statusCode = 401; return res.end('{}') }; if (listMode === 'invalid') return res.end('{}'); return res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }, { id: 'fixture-image' }, { id: 'fixture-chat' }] })) }
    if (req.url === '/orders') return res.end(JSON.stringify({ paymentUrl: 'https://payment.example.test/checkout/' + body.orderNo }))
    if (providerPath === '/images/generations') { imageCalls++; if (imageMode === 'failure') { res.statusCode = 502; return res.end('{}') }; return res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNncAAAAASUVORK5CYII=' }] })) }
    const isModelProbe = body.messages?.at(-1)?.content === '请只回复：连接测试成功'
    if (!isModelProbe) calls++; if (mode === 'failure') { res.statusCode = 502; return res.end('{}') }
    if (mode === 'embedded-error') return res.end(JSON.stringify({ error: { message: 'No eligible upstream supports the requested interface or model' } }))
    if (body.stream) {
      assert.equal(body.stream_options?.include_usage, true)
      assert.equal(req.headers.authorization, 'Bearer test-only-provider-secret')
      const current = mode; res.setHeader('content-type', 'text/event-stream'); res.flushHeaders()
      const emit = (data: any) => res.write('data: ' + JSON.stringify(data) + '\r\n\r\n')
      emit({ choices: [{ index: 0, delta: { reasoning_content: 'private fixture reasoning' } }] })
      await new Promise(resolve => setTimeout(resolve, 40))
      if (res.destroyed) return
      emit({ choices: [{ index: 0, delta: { content: '*星澜微笑*\n\n' } }] })
      await new Promise(resolve => setTimeout(resolve, current === 'slow' ? 800 : 180))
      if (res.destroyed) return
      if (current === 'interrupted') return res.end()
      const bytes = Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '你好，小猫。' } }] }) + '\r\n\r\n')
      for (const byte of bytes) res.write(Buffer.from([byte]))
      emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      if (current !== 'missing-usage') emit({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } } })
      return res.end('data: [DONE]\r\n\r\n')
    }
    res.end(JSON.stringify({ choices: [{ message: { content: 'Test fixture reply' } }], ...(mode === 'missing-usage' ? {} : { usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } } }) }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '0.0.0.0', resolve))
  const upstreamPort = (upstream.address() as any).port; const upstreamUrl = `http://127.0.0.1:${upstreamPort}`
  let userApp: any; let adminApp: any; const cleanup = new Pool({ connectionString: process.env.DATABASE_URL })
  let checks = 0
  try {
    const start = async () => { userApp = await NestFactory.create(AppModule, { logger: false }); adminApp = await NestFactory.create(AdminApiModule, { logger: false }); userApp.setGlobalPrefix('api/v1'); adminApp.setGlobalPrefix('api/v1'); userHttp(userApp); adminHttp(adminApp); await Promise.all([userApp.get(AppService).ready, adminApp.get(AdminApiService).ready]); await userApp.listen(0); await adminApp.listen(0); return { user: `http://127.0.0.1:${userApp.getHttpServer().address().port}/api/v1`, admin: `http://127.0.0.1:${adminApp.getHttpServer().address().port}/api/v1/admin` } }
    let urls = await start()
    const call = async (base: 'user' | 'admin', path: string, token = '', body?: any, method = body === undefined ? 'GET' : 'POST', expected = method === 'POST' ? 201 : 200) => {
      const response = await fetch(urls[base] + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, expected, `${base}${path}: ${JSON.stringify(data)}`); checks++; return data
    }
    await call('admin', '/overview', '', undefined, 'GET', 401)
    await call('user', '/wallet', '', undefined, 'GET', 401)
    assert.deepEqual(await call('user', '/characters'), [])
    await call('user', '/admin/overview', '', undefined, 'GET', 404)
    const adminLogin = await call('admin', '/login', '', { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }); const at = adminLogin.token
    const ch = await call('admin', '/characters', at, { name: '集成测试角色', description: 'Test-only persona', cost: 1, published: true })
    assert.equal((await call('user', '/characters'))[0].id, ch.id)
    await call('admin', '/characters/' + ch.id, at, { description: 'Updated persona', cost: 2 }, 'PATCH')
    assert.equal((await call('user', '/characters/' + ch.id)).cost, 2)
    await call('admin', '/characters/' + ch.id, at, { cost: 1 }, 'PATCH')
    await call('admin', '/characters', at, { name: '', description: 'invalid', cost: 1 }, 'POST', 400)
    const imported = await call('admin', '/characters/import', at, { card: { spec: 'chara_card_v2', data: { name: 'Imported test card', description: 'Imported persona', first_mes: 'hello', tags: ['import'] } } }); assert.equal(imported.published, false)
    const exported = await call('admin', '/characters/' + imported.id + '/export', at); assert.equal(exported.spec, 'chara_card_v2'); assert.equal(exported.data.first_mes, 'hello')
    await call('admin', '/characters/' + imported.id, at, { reason: 'import test cleanup' }, 'DELETE')
    const model = await call('admin', '/models', at, { name: 'Fixture chat', baseUrl: upstreamUrl, model: 'fixture-chat', apiKey: 'test-only-provider-secret', inputRate: 20, outputRate: 40, cacheReadRate: 2, cacheWriteRate: 25 }); assert.equal(model.isDefault, true)
    const imageModel = await call('admin', '/models', at, { name: 'Fixture image', baseUrl: upstreamUrl, model: 'fixture-image', apiKey: 'test-only-image-secret', task: 'image', imageRate: 5 }); assert.equal(imageModel.isDefault, true)
    await call('admin', '/models/' + model.id, at, { isDefault: false }, 'PATCH', 409)
    await call('admin', '/models', at, { name: 'Invalid default', baseUrl: upstreamUrl, model: 'fixture-chat', isDefault: true }, 'POST', 400)
    const standby = await call('admin', '/models', at, { name: 'Standby chat', baseUrl: upstreamUrl, model: 'fixture-chat', apiKey: 'standby-test-key' }); assert.equal(standby.isDefault, false)
    await call('admin', '/models/' + standby.id, at, { isDefault: true }, 'PATCH'); assert.equal((await call('admin', '/models', at)).find((item: any) => item.id === model.id).isDefault, false)
    await call('admin', '/models/' + model.id, at, { isDefault: true }, 'PATCH'); await call('admin', '/models/' + standby.id, at, undefined, 'DELETE')
    assert.equal((await call('admin', '/models/' + model.id + '/test', at, {})).success, true)
    const rootDiscovery = await call('admin', '/models/discover', at, { baseUrl: upstreamUrl, apiKey: 'unsaved-test-key' }); assert.deepEqual(rootDiscovery.models, ['fixture-chat', 'fixture-image']); assert.equal(rootDiscovery.baseUrl, upstreamUrl + '/v1')
    const htmlFailure = await call('admin', '/models/discover', at, { baseUrl: upstreamUrl + '/website', apiKey: 'test-only-key' }, 'POST', 502); assert.ok(htmlFailure.message.includes('网页'))
    assert.deepEqual((await call('admin', '/models/discover', at, { id: model.id, baseUrl: upstreamUrl })).models, ['fixture-chat', 'fixture-image'])
    await call('admin', '/models/discover', at, { id: model.id, baseUrl: 'https://other-provider.example/v1' }, 'POST', 400)
    await call('admin', '/models/discover', at, { baseUrl: upstreamUrl }, 'POST', 400)
    await call('admin', '/models/discover', at, { baseUrl: 'not-an-address', apiKey: 'test-only-secret' }, 'POST', 400)
    listMode = 'failure'; await call('admin', '/models/discover', at, { id: model.id }, 'POST', 502)
    listMode = 'invalid'; await call('admin', '/models/discover', at, { id: model.id }, 'POST', 502); listMode = 'success'
    const availableImageModels = await call('admin', '/characters/cover/models', at); assert.equal(availableImageModels[0].id, imageModel.id); assert.ok(!JSON.stringify(availableImageModels).includes('key'))
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNncAAAAASUVORK5CYII='
    const uploadCover = await call('admin', '/characters/cover/upload', at, { name: 'test-cover.png', base64: png }); assert.equal(uploadCover.url, 'data:image/png;base64,' + png)
    await call('admin', '/characters/' + ch.id, at, { image: uploadCover.url }, 'PATCH'); assert.equal((await call('user', '/characters/' + ch.id)).image, uploadCover.url)
    await call('admin', '/characters/cover/upload', at, { name: 'invalid.png', base64: Buffer.from('not an image').toString('base64') }, 'POST', 400)
    await call('admin', '/characters/' + ch.id, at, { image: 'data:image/svg+xml;base64,' + png }, 'PATCH', 400)
    const adminWalletBefore = await call('admin', '/me', at); const coverRequest = { prompt: '真实 API 测试封面', modelId: imageModel.id, requestId: 'cover-once' }; const generatedCover = await call('admin', '/characters/cover/generate', at, coverRequest); assert.equal(generatedCover.credits, 0)
    const imageCallCount = imageCalls; const duplicateCover = await call('admin', '/characters/cover/generate', at, coverRequest); assert.equal(duplicateCover.id, generatedCover.id); assert.equal(imageCalls, imageCallCount)
    await call('admin', '/characters/cover/generate', at, { ...coverRequest, prompt: 'different' }, 'POST', 409)
    await call('admin', '/characters/cover/generate', at, { ...coverRequest, requestId: 'invalid-cover-model', modelId: model.id }, 'POST', 400)
    imageMode = 'failure'; await call('admin', '/characters/cover/generate', at, { ...coverRequest, requestId: 'failed-cover' }, 'POST', 502); imageMode = 'success'
    const adminWalletAfter = await call('admin', '/me', at); assert.equal(adminWalletAfter.balance, adminWalletBefore.balance); assert.equal(adminWalletAfter.frozen, 0)
    assert.equal((await call('admin', '/characters/cover/images', at)).length, 2)
    const estimate = await call('admin', '/billing/estimate', at, { modelId: model.id, inputTokens: 1000, outputTokens: 100, cachedTokens: 800, cacheWriteTokens: 100, minimum: 1 }); assert.equal(estimate.chargedCredits, 11)
    await call('admin', '/billing/estimate', at, { modelId: model.id, inputTokens: 10, cachedTokens: 20 }, 'POST', 400)
    await call('admin', '/models/' + model.id, at, undefined, 'DELETE', 409)
    const u = await call('admin', '/users', at, { email: 'integration-user@example.test', name: '测试用户', password: 'UserPass#12345', balance: 100, role: 'user' })
    const login = await call('user', '/auth/login', '', { email: u.email, password: 'UserPass#12345' }); const ut = login.token
    assert.equal((await call('user', '/wallet', ut)).balance, 100)
    await call('admin', '/users', at, { email: u.email, name: '重复邮箱', password: 'UserPass#12345' }, 'POST', 409)
    await call('admin', '/users/' + u.id + '/credits', at, { amount: 500, reason: 'integration top-up', requestId: 'credits-1' })
    assert.equal((await call('user', '/wallet', ut)).balance, 600)
    const retry = await call('admin', '/users/' + u.id + '/credits', at, { amount: 500, reason: 'integration top-up', requestId: 'credits-1' }); assert.equal(retry.duplicate, true)
    await call('admin', '/users/' + u.id + '/credits', at, { amount: 501, reason: 'integration top-up', requestId: 'credits-1' }, 'POST', 409)
    await call('admin', '/users/' + u.id + '/credits', at, { amount: -50, reason: 'integration decrease', requestId: 'credits-2' })
    assert.equal((await call('user', '/wallet', ut)).balance, 550)
    await call('admin', '/users/' + u.id + '/credits', at, { amount: -9999, reason: 'overdraft', requestId: 'credits-3' }, 'POST', 400)
    const creditsBody = { amount: 10, reason: 'concurrent same request', requestId: 'credits-concurrent' }
    const creditsResult = await Promise.all([call('admin', '/users/' + u.id + '/credits', at, creditsBody), call('admin', '/users/' + u.id + '/credits', at, creditsBody)]); assert.equal((await call('user', '/wallet', ut)).balance, 560); assert.equal(creditsResult.filter(item => item.duplicate).length, 1)
    const chat = await call('user', '/conversations', ut, { characterId: ch.id })
    const messageBody = { content: 'integration cache billing', clientMessageId: 'message-1' }
    const reply = await call('user', '/conversations/' + chat.id + '/messages', ut, messageBody); assert.equal(reply.chargedCredits, 11); assert.equal(reply.usage.cachedTokens, 800); assert.equal(reply.balance, 549)
    assert.equal((await call('user', '/conversations/' + chat.id + '/messages', ut, messageBody)).duplicate, true); assert.equal(calls, 1)
    const parallel = await Promise.all([call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'parallel', clientMessageId: 'message-2' }), call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'parallel', clientMessageId: 'message-2' })]); assert.equal(parallel[0].messageId, parallel[1].messageId); assert.equal(calls, 2)
    const history = await call('user', '/conversations/' + chat.id + '/messages', ut); assert.deepEqual(history.map((item: any) => item.role), ['user', 'assistant', 'user', 'assistant'])
    const beforeFailure = (await call('user', '/wallet', ut)).balance
    mode = 'failure'; await call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'failure', clientMessageId: 'message-failed' }, 'POST', 502); assert.equal((await call('user', '/wallet', ut)).balance, beforeFailure); assert.equal((await call('user', '/wallet', ut)).frozen, 0)
    mode = 'embedded-error'; const embeddedError = await call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'embedded-error', clientMessageId: 'embedded-error' }, 'POST', 502); assert.ok(embeddedError.message.includes('渠道可用性')); assert.equal((await call('user', '/wallet', ut)).balance, beforeFailure); assert.equal((await call('user', '/wallet', ut)).frozen, 0)
    mode = 'missing-usage'; await call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'no usage', clientMessageId: 'no-usage' }, 'POST', 502); assert.equal((await call('user', '/wallet', ut)).balance, beforeFailure)
    mode = 'success'
    const second = await call('user', '/auth/register', '', { email: 'other@example.test', name: 'Other', password: 'OtherPass#1234', role: 'admin', balance: 99999 }); assert.equal(second.role, 'user'); assert.equal(second.balance, 0)
    const secondToken = (await call('user', '/auth/login', '', { email: second.email, password: 'OtherPass#1234' })).token
    await call('user', '/conversations/' + chat.id + '/messages', secondToken, undefined, 'GET', 404)
    await call('admin', '/overview', secondToken, undefined, 'GET', 403)
    const operator = await call('admin', '/users', at, { email: 'operator@example.test', name: 'Operator', password: 'Operator#1234', role: 'operator' }); const ot = (await call('admin', '/login', '', { email: operator.email, password: 'Operator#1234' })).token
    await call('admin', '/users/' + u.id + '/credits', ot, { amount: 1, reason: 'denied', requestId: 'denied' }, 'POST', 403)
    await call('admin', '/models/discover', ot, { id: model.id }, 'POST', 403)
    const operatorCover = await call('admin', '/characters/cover/upload', ot, { name: 'operator-cover.png', base64: png }); assert.ok(operatorCover.url.startsWith('data:image/png'))
    assert.equal((await call('admin', '/characters/cover/images', ot)).length, 1)
    const auditor = await call('admin', '/users', at, { email: 'auditor@example.test', name: 'Auditor', password: 'Auditor#12345', role: 'auditor' }); const auditorToken = (await call('admin', '/login', '', { email: auditor.email, password: 'Auditor#12345' })).token
    await call('admin', '/characters/cover/upload', auditorToken, { name: 'denied.png', base64: png }, 'POST', 403)
    await call('admin', '/characters/cover/generate', ut, { ...coverRequest, requestId: 'denied-user-cover' }, 'POST', 403)
    await call('user', '/favorites/' + ch.id, ut, { favorite: true }, 'PATCH'); assert.equal((await call('user', '/favorites', ut)).length, 1)
    const generated = await call('user', '/images', ut, { prompt: 'test pixel', conversationId: chat.id, requestId: 'image-1' }); assert.equal(generated.chargedCredits, 5)
    await call('user', '/images/' + generated.id, ut, { favorite: true }, 'PATCH'); assert.equal((await call('user', '/images', ut))[0].favorite, true)
    await call('user', '/images/' + generated.id, secondToken, undefined, 'DELETE', 404)
    const uploaded = await call('user', '/images/upload', ut, { name: 'Uploaded test image', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNncAAAAASUVORK5CYII=' }); assert.equal(uploaded.credits, 0); assert.ok(uploaded.url.startsWith('data:image/png'))
    await call('user', '/images/upload', ut, { name: 'invalid', base64: Buffer.from('<svg></svg>').toString('base64') }, 'POST', 400)
    await call('user', '/images/' + uploaded.id, ut, undefined, 'DELETE')
    const recharge = await call('admin', '/plans', at, { name: '测试充值', type: 'recharge', price: 100, credits: 200 })
    const member = await call('admin', '/plans', at, { name: '测试会员', type: 'membership', price: 200, credits: 100, days: 30, discount: 0.8 })
    await call('user', '/orders', ut, { planId: recharge.id }, 'POST', 503)
    await call('admin', '/payment', at, { gatewayUrl: upstreamUrl, notifyUrl: 'https://api.example.test/api/v1/payments/callback', merchantId: 'fixture-merchant', secret: 'fixture-payment-secret' }, 'PATCH')
    const newOrder = await call('user', '/orders', ut, { planId: member.id }); const timestamp = String(Date.now()); const callback: any = { orderNo: newOrder.orderNo, eventId: 'event-1', amount: 200, status: 'paid', timestamp }
    callback.signature = createHmac('sha256', 'fixture-payment-secret').update(`${callback.orderNo}|${callback.eventId}|${callback.amount}|paid|${timestamp}`).digest('hex')
    await call('user', '/payments/callback', '', { ...callback, signature: 'invalid' }, 'POST', 401)
    const prePayment = (await call('user', '/wallet', ut)).balance
    await call('user', '/payments/callback', '', callback); const paidWallet = await call('user', '/wallet', ut); assert.equal(paidWallet.balance, prePayment + 100); assert.equal(paidWallet.membership, '测试会员'); assert.ok(paidWallet.membershipUntil)
    assert.equal((await call('user', '/payments/callback', '', callback)).duplicate, true); assert.equal((await call('user', '/wallet', ut)).balance, prePayment + 100)
    await call('admin', '/plans/' + member.id, at, undefined, 'DELETE', 409)
    const cancelled = await call('user', '/orders', ut, { planId: recharge.id }); await call('user', '/orders/' + cancelled.id + '/cancel', ut, {})
    const rawModels = await adminApp.get(AdminApiService).db.rows('SELECT key_cipher FROM platform_models'); assert.ok(rawModels.every((item: any) => !item.key_cipher.includes('test-only')))
    const logs = await call('admin', '/logs', at); const serialized = JSON.stringify(logs); assert.ok(!serialized.includes('UserPass#') && !serialized.includes('test-only-provider-secret') && !serialized.includes('fixture-payment-secret')); assert.ok(logs.some((item: any) => item.action === 'credits.adjust')); assert.ok(logs.some((item: any) => item.action === 'order.paid'))
    const creditLog = logs.find((item: any) => item.action === 'credits.adjust' && item.target === u.id); assert.equal(creditLog.actionLabel, '调整积分'); assert.equal(creditLog.targetLabel, u.email); assert.equal(creditLog.actor, 'integration-admin@example.test'); assert.equal(creditLog.targetAccount, u.email)
    assert.ok(logs.some((item: any) => item.action === 'character.update' && item.targetLabel === '角色：集成测试角色')); assert.ok(!serialized.includes(png)); assert.ok(!serialized.includes('unsaved-test-key')); assert.ok(logs.some((item: any) => item.actionLabel === '生成角色封面'))
    const persistentBalance = (await call('user', '/wallet', ut)).balance
    await userApp.close(); await adminApp.close(); urls = await start(); assert.equal((await call('user', '/wallet', ut)).balance, persistentBalance); assert.equal((await call('user', '/conversations/' + chat.id + '/messages', ut)).length, 5)
    const runStreamTests = async (label: string) => {
      const streamChat = await call('user', '/conversations', ut, { characterId: ch.id })
      const headers = { authorization: 'Bearer ' + ut, 'content-type': 'application/json' }
      const body = { content: label + ' streaming', clientMessageId: label + '-stream' }
      const send = (data: any, signal?: AbortSignal) => fetch(urls.user + '/conversations/' + streamChat.id + '/messages/stream', { method: 'POST', headers, body: JSON.stringify(data), signal })
      const collect = async (data: any) => { const response = await send(data); assert.equal(response.status, 200); const events = []; for await (const frame of readSse(response.body!)) events.push({ event: frame.event, data: JSON.parse(frame.data) }); return events }
      const before = (await call('user', '/wallet', ut)).balance
      const response = await send(body); const events: any[] = []; let first = 0
      for await (const frame of readSse(response.body!)) { const data = JSON.parse(frame.data); if (frame.event === 'delta' && !first) first = Date.now(); events.push({ event: frame.event, data }) }
      assert.ok(Date.now() - first >= 100, 'First delta must arrive before the final response')
      assert.equal(events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), '*星澜微笑*\n\n你好，小猫。')
      assert.deepEqual(events.filter(e => e.event === 'status').map(e => e.data.phase), ['thinking', 'responding'])
      assert.ok(!JSON.stringify(events).includes('private fixture reasoning'))
      const done = events.find(e => e.event === 'done')?.data; assert.ok(done, JSON.stringify(events)); assert.equal(done.usage.cachedTokens, 800)
      const requestStatus = await call('user', '/conversations/' + streamChat.id + '/messages/requests/' + body.clientMessageId, ut); assert.equal(requestStatus.status, 'completed'); assert.equal(requestStatus.result.messageId, done.messageId)
      await call('user', '/conversations/' + streamChat.id + '/messages/requests/' + body.clientMessageId, secondToken, undefined, 'GET', 404)
      assert.equal((await call('user', '/wallet', ut)).balance, before - done.chargedCredits)
      assert.equal((await call('user', '/conversations/' + streamChat.id + '/messages', ut)).at(-1).content, done.reply)
      const previousCalls = calls; const duplicate = await collect(body); assert.equal(duplicate.length, 1); assert.equal(duplicate[0].data.duplicate, true); assert.equal(calls, previousCalls)
      const conflict = await collect({ ...body, content: 'different content' }); assert.equal(conflict[0].data.statusCode, 409)
      const after = before - done.chargedCredits
      for (const failure of ['failure', 'embedded-error', 'missing-usage', 'interrupted']) {
        mode = failure; const result = await collect({ content: failure, clientMessageId: label + failure }); assert.equal(result.at(-1)?.event, 'error', JSON.stringify(result))
        assert.equal((await call('user', '/wallet', ut)).balance, after); assert.equal((await call('user', '/wallet', ut)).frozen, 0)
      }
      mode = 'slow'; const cancel = new AbortController(); const cancellable = await send({ content: 'cancel', clientMessageId: label + '-cancel' }, cancel.signal)
      for await (const frame of readSse(cancellable.body!)) { if (frame.event === 'delta') { cancel.abort(); break } }
      for (let attempt = 0; attempt < 30; attempt++) { if ((await call('user', '/wallet', ut)).frozen === 0) break; await new Promise(resolve => setTimeout(resolve, 20)) }
      const refunded = await call('user', '/wallet', ut); assert.equal(refunded.frozen, 0); assert.equal(refunded.balance, after)
      assert.equal((await call('user', '/conversations/' + streamChat.id + '/messages/requests/' + label + '-cancel', ut)).status, 'failed')
      assert.equal((await call('user', '/conversations/' + streamChat.id + '/messages', ut)).length, 2)
      mode = 'success'; const retried = await collect({ content: 'cancel', clientMessageId: label + '-cancel' }); assert.equal(retried.at(-1)?.event, 'done')
      await call('user', '/conversations/' + streamChat.id, ut, undefined, 'DELETE')
      console.log(label + ': incremental SSE, cache usage, idempotency, failures, disconnect refunds and retry passed')
    }
    await runStreamTests('Direct HTTP')
    if (process.env.SILLYTAVERN_URL) {
      assert.equal((await fetch(process.env.SILLYTAVERN_URL + '/csrf-token')).status, 401, 'SillyTavern Core must require authentication')
      process.env.AI_ENGINE = 'sillytavern'
      await call('admin', '/models/' + model.id, at, { baseUrl: `http://host.docker.internal:${upstreamPort}` }, 'PATCH')
      const coreReply = await call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'Actual SillyTavern Core round trip', clientMessageId: 'actual-core' }); assert.equal(coreReply.usage.cachedTokens, 800); assert.equal(coreReply.chargedCredits, 9)
      await runStreamTests('Docker SillyTavern Core')
      process.env.AI_ENGINE = 'direct'
      await call('admin', '/models/' + model.id, at, { baseUrl: upstreamUrl }, 'PATCH')
      console.log('Actual Docker SillyTavern Core: authenticated CSRF round trip and usage billing passed')
    }
    await call('user', '/conversations/' + chat.id, ut, { title: '重命名', archived: true, pinned: true }, 'PATCH'); await call('user', '/conversations/' + chat.id + '/messages', ut, { content: 'archive', clientMessageId: 'archive' }, 'POST', 400)
    await call('user', '/conversations/' + chat.id, ut, { archived: false }, 'PATCH')
    await call('admin', '/users/' + second.id, at, { status: 'disabled' }, 'PATCH'); await call('user', '/wallet', secondToken, undefined, 'GET', 401)
    await call('admin', '/users/' + second.id, at, { reason: 'test cleanup' }, 'DELETE'); assert.ok(!(await call('admin', '/users', at)).some((item: any) => item.id === second.id))
    await call('admin', '/users/' + adminLogin.user.id, at, { reason: 'self-delete' }, 'DELETE', 400)
    await call('admin', '/characters/' + ch.id, at, { published: false }, 'PATCH'); assert.deepEqual(await call('user', '/characters'), [])
    await call('user', '/conversations', ut, { characterId: ch.id }, 'POST', 404)
    await call('admin', '/characters/' + ch.id, at, { reason: 'test deletion' }, 'DELETE'); await call('user', '/characters/' + ch.id, '', undefined, 'GET', 404)
    await call('user', '/images/' + generated.id, ut, undefined, 'DELETE'); assert.deepEqual(await call('user', '/images', ut), [])
    await call('user', '/conversations/' + chat.id, ut, undefined, 'DELETE'); assert.deepEqual(await call('user', '/conversations', ut), [])
    await call('user', '/auth/logout', ut, {}); await call('user', '/wallet', ut, undefined, 'GET', 401)
    console.log(`PostgreSQL integration passed: ${checks} HTTP checks, CRUD, cache billing, cross-API linkage, RBAC, payment signature/idempotency and restart persistence.`)
  } finally { await userApp?.close(); await adminApp?.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); await cleanup.query('DROP SCHEMA IF EXISTS "' + process.env.DATABASE_SCHEMA + '" CASCADE'); await cleanup.end() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
