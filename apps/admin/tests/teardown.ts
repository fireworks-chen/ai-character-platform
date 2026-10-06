import { Database, loadEnvironment } from '@ai-character/data'
export default async function teardown() { loadEnvironment(); process.env.DATABASE_SCHEMA = 'ui_admin_test'; const db = new Database(); try { await db.rows('DROP SCHEMA IF EXISTS ui_admin_test CASCADE') } finally { await db.close() } }
