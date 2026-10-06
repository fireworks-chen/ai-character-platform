import { defineConfig } from '@playwright/test'
import { loadEnvironment } from '@ai-character/data'
loadEnvironment()
const env = { ...process.env, DATABASE_SCHEMA: 'ui_web_test', BOOTSTRAP_ADMIN_EMAIL: 'ui-admin@example.test', BOOTSTRAP_ADMIN_PASSWORD: 'UITestAdmin#123', SKIP_BOOTSTRAP_ADMIN: 'false', ADMIN_CORS_ORIGINS: 'http://127.0.0.1:4373', CORS_ORIGINS: 'http://127.0.0.1:4373' } as Record<string, string>
export default defineConfig({ testDir: './tests', workers: 1, globalTeardown: './tests/teardown.ts', use: { baseURL: 'http://127.0.0.1:4373', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' }, webServer: [
  { command: 'node tests/provider.cjs', port: 3420, reuseExistingServer: false },
  { command: 'pnpm --filter @ai-character/admin-api start:dev', port: 3410, reuseExistingServer: false, env: { ...env, ADMIN_API_PORT: '3410' } },
  { command: 'pnpm --filter @ai-character/api start:dev', port: 3400, reuseExistingServer: false, env: { ...env, PORT: '3400' } },
  { command: 'pnpm dev --port 4373 --strictPort', port: 4373, reuseExistingServer: false, env: { VITE_API_URL: 'http://127.0.0.1:3400/api/v1' } },
] })
