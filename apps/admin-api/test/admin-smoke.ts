import 'reflect-metadata'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { NestFactory } from '@nestjs/core'
import { loadEnvironment } from '@ai-character/data'
import { AdminApiModule } from '../src/admin-api.module'
import { AdminApiService } from '../src/admin-api.service'
import { setupHttp } from '../src/http-setup'
async function main() {
  loadEnvironment(); process.env.DATABASE_SCHEMA = 'admin_test_' + process.pid; process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.test'; process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminTestPass#123'
  const cleanup = new Pool({ connectionString: process.env.DATABASE_URL }); const app = await NestFactory.create(AdminApiModule, { logger: false }); app.setGlobalPrefix('api/v1'); setupHttp(app)
  try { await app.get(AdminApiService).ready; await app.listen(0); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1/admin`; assert.equal((await fetch(base + '/overview')).status, 401); const login = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }) }); assert.equal(login.status, 201); const { token } = await login.json(); const response = await fetch(base + '/overview', { headers: { authorization: 'Bearer ' + token } }); const data = await response.json(); assert.equal(data.database, 'PostgreSQL'); assert.equal(data.characters, 0); assert.equal(data.creditsInCirculation, 0); console.log('Admin PostgreSQL auth and empty-database checks passed') } finally { await app.close(); await cleanup.query('DROP SCHEMA IF EXISTS "' + process.env.DATABASE_SCHEMA + '" CASCADE'); await cleanup.end() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
