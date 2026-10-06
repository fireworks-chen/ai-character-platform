export const API = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:3100/api/v1'
export type AdminUser = { id: string; email: string; name: string; role: string; status: string; membership: string; membershipUntil?: string; balance: number; frozen: number; createdAt: string }
export type AdminCharacter = { id: string; name: string; subtitle: string; opening: string; description: string; tags: string[]; image: string; gender: string; cost: number; online: boolean; published: boolean }
export type Model = { id: string; name: string; baseUrl: string; model: string; apiKeyConfigured: boolean; task: string; inputRate: number; outputRate: number; cacheReadRate: number; cacheWriteRate: number; imageRate: number; enabled: boolean; isDefault: boolean }
export type Plan = { id: string; name: string; type: string; price: number; credits: number; days: number; discount: number; enabled: boolean }
export type Ledger = { id: string; userId: string; type: string; amount: number; balanceAfter: number; referenceId: string; reason: string; createdAt: string }
export type Audit = { id: string; actor: string; actorId: string; action: string; actionLabel: string; target: string; targetLabel: string; targetAccount: string; before: unknown; after: unknown; reason: string; createdAt: string }
export type Order = { id: string; orderNo: string; user: string; plan: string; type: string; amount: number; credits: number; status: string; createdAt: string; paidAt?: string }
export type Overview = { characters: number; publishedCharacters: number; users: number; conversations: number; messages: number; creditsInCirculation: number; pendingOrders: number; providerConfigured: boolean; imageConfigured: boolean; paymentConfigured: boolean; database: string; recentLedger: Ledger[] }
export type Payment = { gatewayUrl: string; notifyUrl: string; merchantId: string; configured: boolean; secretConfigured: boolean }
export async function request<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', timeout = 25000): Promise<T> {
  const token = localStorage.getItem('admin_token')
  const response = await fetch(API + '/admin' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') { localStorage.removeItem('admin_token'); window.dispatchEvent(new Event('admin-session-expired')) }
    const payload = await response.json().catch(() => null)
    throw new Error(Array.isArray(payload?.message) ? payload.message.join('；') : payload?.message || `请求失败（${response.status}）`)
  }
  return response.json()
}
