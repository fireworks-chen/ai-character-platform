import { Test } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'

describe('API contract', () => {
  let app: INestApplication
  beforeAll(async () => { const module = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = module.createNestApplication(); await app.init() })
  afterAll(async () => app.close())
  it('lists characters', async () => { const res = await request(app.getHttpServer()).get('/characters'); expect(res.status).toBe(200); expect(res.body.length).toBeGreaterThanOrEqual(5) })
  it('returns a wallet balance', async () => { const res = await request(app.getHttpServer()).get('/wallet'); expect(res.status).toBe(200); expect(res.body).toHaveProperty('balance') })
  it('creates a conversation and charges messages', async () => { const created = await request(app.getHttpServer()).post('/conversations').send({ characterId: '1' }); expect(created.status).toBe(201); const message = await request(app.getHttpServer()).post(`/conversations/${created.body.id}/messages`).send({ content: '你好' }); expect(message.status).toBe(201); expect(message.body.chargedCredits).toBeGreaterThan(0) })
})
