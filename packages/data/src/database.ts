import { Pool, PoolClient } from 'pg'
import { resolve } from 'node:path'

export const dataDirectory = resolve(__dirname, '../../..', '.data')
export class Database {
  private pool: Pool
  private initialized: Promise<unknown>
  readonly backend = 'PostgreSQL' as const
  constructor() {
    if (!process.env.DATABASE_URL) throw new Error('必须配置 DATABASE_URL；本项目只支持 PostgreSQL')
    const namespace = process.env.DATABASE_SCHEMA || 'public'
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)) throw new Error('DATABASE_SCHEMA 无效')
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, options: '-c search_path=' + namespace + ' -c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000' })
    this.initialized = this.createNamespace(namespace)
  }
  private async createNamespace(namespace: string) {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(726499)'); await client.query('CREATE SCHEMA IF NOT EXISTS "' + namespace + '"'); await client.query('COMMIT') }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  private async query<T = any>(sql: string, values: any[] = [], client?: PoolClient): Promise<T[]> {
    await this.initialized
    let index = 0
    return (await (client || this.pool).query(sql.replace(/\?/g, () => '$' + ++index), values)).rows as T[]
  }
  async rows<T = any>(sql: string, values: any[] = []): Promise<T[]> {
    return this.query<T>(sql, values)
  }
  async transaction<T>(fn: (query: <R = any>(sql: string, values?: any[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    await this.initialized
      const client = await this.pool.connect()
      try { await client.query('BEGIN'); const result = await fn((sql, values) => this.query(sql, values, client)); await client.query('COMMIT'); return result }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
  }
  async close() { await this.pool.end() }
}

export const schema = [
  `CREATE TABLE IF NOT EXISTS platform_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', membership TEXT NOT NULL DEFAULT '基础会员', membership_until TEXT, balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0), frozen BIGINT NOT NULL DEFAULT 0 CHECK(frozen >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id), expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, subtitle TEXT NOT NULL, description TEXT NOT NULL, opening TEXT NOT NULL, tags TEXT NOT NULL, image TEXT NOT NULL, gender TEXT NOT NULL, cost INTEGER NOT NULL CHECK(cost >= 1), online INTEGER NOT NULL, published INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_models (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, key_cipher TEXT NOT NULL DEFAULT '', task TEXT NOT NULL, input_rate NUMERIC(14,4) NOT NULL, output_rate NUMERIC(14,4) NOT NULL, cache_read_rate NUMERIC(14,4) NOT NULL, cache_write_rate NUMERIC(14,4) NOT NULL, image_rate INTEGER NOT NULL, enabled INTEGER NOT NULL, is_default INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='platform_models' AND column_name='input_rate' AND data_type='real') THEN ALTER TABLE platform_models ALTER COLUMN input_rate TYPE NUMERIC(14,4), ALTER COLUMN output_rate TYPE NUMERIC(14,4), ALTER COLUMN cache_read_rate TYPE NUMERIC(14,4), ALTER COLUMN cache_write_rate TYPE NUMERIC(14,4); END IF; END $$`,
  `CREATE TABLE IF NOT EXISTS platform_conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id), character_id TEXT NOT NULL REFERENCES platform_characters(id), title TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_messages (id TEXT PRIMARY KEY, sequence BIGSERIAL, conversation_id TEXT NOT NULL REFERENCES platform_conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, usage_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
  `ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS sequence BIGSERIAL`,
  `CREATE TABLE IF NOT EXISTS platform_requests (request_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id), payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, reserved INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id), type TEXT NOT NULL, amount BIGINT NOT NULL, balance_after BIGINT NOT NULL, reference_id TEXT NOT NULL, reason TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 1), credits INTEGER NOT NULL CHECK(credits >= 0), days INTEGER NOT NULL, discount NUMERIC(5,4) NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='platform_plans' AND column_name='discount' AND data_type='real') THEN ALTER TABLE platform_plans ALTER COLUMN discount TYPE NUMERIC(5,4); END IF; END $$`,
  `CREATE TABLE IF NOT EXISTS platform_orders (id TEXT PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES platform_users(id), plan_id TEXT NOT NULL REFERENCES platform_plans(id), plan_json TEXT NOT NULL, amount INTEGER NOT NULL, credits INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, payment_url TEXT, event_id TEXT UNIQUE, created_at TEXT NOT NULL, paid_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS platform_images (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id), conversation_id TEXT REFERENCES platform_conversations(id), url TEXT NOT NULL, prompt TEXT NOT NULL, credits INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_favorites (user_id TEXT NOT NULL REFERENCES platform_users(id), character_id TEXT NOT NULL REFERENCES platform_characters(id), PRIMARY KEY(user_id,character_id))`,
  `CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_character_meta (character_id TEXT PRIMARY KEY REFERENCES platform_characters(id) ON DELETE CASCADE, creator_id TEXT REFERENCES platform_users(id), system_prompt TEXT NOT NULL DEFAULT '', personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '', alternate_greetings TEXT NOT NULL DEFAULT '[]', world_book TEXT NOT NULL DEFAULT '[]', extensions TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_world_books (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES platform_users(id), character_id TEXT REFERENCES platform_characters(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', entries TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_knowledge (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES platform_users(id), character_id TEXT REFERENCES platform_characters(id) ON DELETE CASCADE, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 3, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, name TEXT NOT NULL, content TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_conversation_state (conversation_id TEXT PRIMARY KEY REFERENCES platform_conversations(id) ON DELETE CASCADE, relationship INTEGER NOT NULL DEFAULT 0, status_json TEXT NOT NULL DEFAULT '{}', director_note TEXT NOT NULL DEFAULT '', persona_id TEXT REFERENCES platform_personas(id), updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_social_likes (user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, character_id TEXT NOT NULL REFERENCES platform_characters(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(user_id, character_id))`,
  `CREATE TABLE IF NOT EXISTS platform_comments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, character_id TEXT NOT NULL REFERENCES platform_characters(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_follows (follower_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, followed_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(follower_id, followed_id))`,
  `CREATE TABLE IF NOT EXISTS platform_tasks (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', reward INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'daily', enabled INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS platform_user_tasks (user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE, progress INTEGER NOT NULL DEFAULT 0, claimed INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, task_id, day))`,
  `CREATE TABLE IF NOT EXISTS platform_checkins (user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, day TEXT NOT NULL, streak INTEGER NOT NULL DEFAULT 1, reward INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY(user_id, day))`,
  `CREATE TABLE IF NOT EXISTS platform_miniapps (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES platform_characters(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES platform_users(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', schema_json TEXT NOT NULL DEFAULT '{}', published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_game_saves (id TEXT PRIMARY KEY, miniapp_id TEXT NOT NULL REFERENCES platform_miniapps(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, slot TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, UNIQUE(miniapp_id,user_id,slot))`,
  `CREATE TABLE IF NOT EXISTS platform_novels (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES platform_users(id), title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_novel_chapters (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES platform_novels(id) ON DELETE CASCADE, number INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(novel_id,number))`,
  `CREATE TABLE IF NOT EXISTS platform_invites (user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE, code TEXT UNIQUE NOT NULL, invited_by TEXT REFERENCES platform_users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS platform_commissions (id TEXT PRIMARY KEY, beneficiary_id TEXT NOT NULL REFERENCES platform_users(id), source_user_id TEXT REFERENCES platform_users(id), order_id TEXT REFERENCES platform_orders(id), amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'available', created_at TEXT NOT NULL, redeemed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS platform_chat_user ON platform_conversations(user_id,deleted,updated_at)`,
  `CREATE INDEX IF NOT EXISTS platform_message_chat ON platform_messages(conversation_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS platform_ledger_user ON platform_ledger(user_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS platform_audit_time ON platform_audit(created_at)`,
  `CREATE INDEX IF NOT EXISTS platform_session_user ON platform_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS platform_images_user ON platform_images(user_id,created_at) WHERE deleted=0`,
  `CREATE INDEX IF NOT EXISTS platform_images_chat ON platform_images(conversation_id)`,
  `CREATE INDEX IF NOT EXISTS platform_orders_user ON platform_orders(user_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS platform_orders_plan ON platform_orders(plan_id)`,
  `CREATE INDEX IF NOT EXISTS platform_comments_character ON platform_comments(character_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS platform_knowledge_owner ON platform_knowledge(owner_id,updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS platform_novel_author ON platform_novels(author_id,updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS platform_commissions_beneficiary ON platform_commissions(beneficiary_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS platform_requests_pending ON platform_requests(user_id,created_at) WHERE status='pending'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS platform_default_model ON platform_models(task) WHERE is_default=1`,
  `CREATE INDEX IF NOT EXISTS platform_characters_public ON platform_characters(created_at) WHERE deleted=0 AND published=1`,
]
