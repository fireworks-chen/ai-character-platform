import { defineConfig } from '@playwright/test'
import { loadEnvironment } from '@ai-character/data'
loadEnvironment()
const env = { ...process.env, DATABASE_SCHEMA: 'ui_admin_test', BOOTSTRAP_ADMIN_EMAIL: 'ui-admin@example.test', BOOTSTRAP_ADMIN_PASSWORD: 'UITestAdmin#123', SKIP_BOOTSTRAP_ADMIN: 'false', ADMIN_CORS_ORIGINS: 'http://127.0.0.1:4274', CORS_ORIGINS: 'http://127.0.0.1:4274' } as Record<string, string>
export default defineConfig({ testDir: './tests', workers: 1, globalTeardown: './tests/teardown.ts', use: { baseURL: 'http://127.0.0.1:4274', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' }, webServer: [
  { command: 'node tests/provider.cjs', port: 3320, reuseExistingServer: false },
  { command: 'pnpm --filter @ai-character/admin-api start:dev', port: 3310, reuseExistingServer: false, env: { ...env, ADMIN_API_PORT: '3310' } },
  { command: 'pnpm --filter @ai-character/api start:dev', port: 3300, reuseExistingServer: false, env: { ...env, PORT: '3300' } },
  { command: 'pnpm dev --port 4274 --strictPort', port: 4274, reuseExistingServer: false, env: { VITE_ADMIN_API_URL: 'http://127.0.0.1:3310/api/v1' } },
] })
