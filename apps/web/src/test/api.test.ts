import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })
describe('user API error and session handling', () => {
  it('forwards the real login token without a demo fallback', async () => { const fetch = vi.fn().mockImplementation(async () => new Response('[]', { status: 200 })); vi.stubGlobal('fetch', fetch); await api('/characters'); expect(fetch.mock.calls[0][1].headers.authorization).toBeUndefined(); localStorage.setItem('user_token', 'opaque-user-session'); await api('/wallet'); expect(fetch.mock.calls[1][1].headers.authorization).toBe('Bearer opaque-user-session') })
  it('expires invalid sessions and presents the server error', async () => { localStorage.setItem('user_token', 'expired'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '登录已失效' }), { status: 401 }))); const handler = vi.fn(); window.addEventListener('user-session-expired', handler); await expect(api('/wallet')).rejects.toThrow('登录已失效'); expect(localStorage.getItem('user_token')).toBeNull(); expect(handler).toHaveBeenCalledOnce(); window.removeEventListener('user-session-expired', handler) })
  it('explains when the user API is unavailable', async () => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))); await expect(api('/auth/login', { email: 'admin@local.host', password: 'password' })).rejects.toThrow('无法连接用户服务') })
})
