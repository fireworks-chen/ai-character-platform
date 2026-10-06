export const API = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1'
export type Character = { id: string; name: string; subtitle: string; description: string; opening: string; tags: string[]; gender: string; image: string; cost: number; online: boolean; published: boolean }
export type User = { id: string; email: string; name: string; membership: string; membershipUntil?: string; balance: number; frozen: number; role: string; status: string }
export type Conversation = { id: string; title: string; characterId: string; characterName: string; image: string; preview: string; updatedAt: string; unread: number; archived: boolean; pinned: boolean; messageCount: number }
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; credits: number; usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number } }
export type Ledger = { id: string; type: string; amount: number; balanceAfter: number; reason: string; createdAt: string }
export type Wallet = { balance: number; frozen: number; membership: string; membershipUntil?: string; ledger: Ledger[] }
export type Image = { id: string; url: string; prompt: string; conversationId: string; favorite: boolean; credits: number; createdAt: string }
export type Plan = { id: string; name: string; type: string; price: number; credits: number; days: number; discount: number }
export type Order = { id: string; orderNo: string; plan: string; amount: number; credits: number; status: string; paymentUrl?: string; createdAt: string }
export type WorldBook = { id: string; characterId?: string; name: string; description?: string; entries: any[]; visibility: string; createdAt?: string; updatedAt?: string }
export type Knowledge = { id: string; characterId?: string; category: string; title: string; content: string; importance: number; pinned: boolean; createdAt?: string; updatedAt?: string }
export type Persona = { id: string; name: string; content: string; isDefault: boolean }
export type ConversationState = { conversationId: string; relationship: number; status: Record<string, any>; directorNote: string; personaId?: string | null }
export type Social = { likes: number; liked: boolean; comments: { id: string; content: string; userId: string; userName: string; createdAt: string }[] }
export type Task = { id: string; code: string; name: string; description: string; reward: number; progress: number; target: number; claimed: boolean }
export type Novel = { id: string; title: string; summary: string; cover: string; tags: string[]; visibility: string; authorId: string; authorName: string; chapterCount: number; updatedAt: string }
export type Invite = { code: string; total: number; commissions: { id: string; amount: number; status: string; createdAt: string }[] }
export async function api<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const token = localStorage.getItem('user_token')
  let response: Response
  try {
    response = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === '/images' ? 150000 : path.includes('/messages') && method === 'POST' ? 110000 : 25000) })
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error('请求超时，请检查用户服务是否正常运行。')
    if (error instanceof TypeError) throw new Error(`无法连接用户服务（${API}），请先运行 pnpm dev:api。`)
    throw error
  }
  if (!response.ok) {
    if (response.status === 401 && !['/auth/login', '/auth/register'].includes(path)) { localStorage.removeItem('user_token'); window.dispatchEvent(new Event('user-session-expired')) }
    const payload = await response.json().catch(() => null)
    throw new Error(Array.isArray(payload?.message) ? payload.message.join('；') : payload?.message || `请求失败（${response.status}）`)
  }
  return response.json()
}
export const getCharacters = () => api<Character[]>('/characters')
export const getCharacter = (id: string) => api<Character>('/characters/' + id)
export const getCharacterMeta = (id: string) => api<any>(`/characters/${id}/meta`)
export const saveCharacterMeta = (id: string, body: any) => api<any>(`/characters/${id}/meta`, body, 'PUT')
export const getConversations = () => api<Conversation[]>('/conversations')
export const getMessages = (id: string) => api<ChatMessage[]>(`/conversations/${id}/messages`)
export const getWallet = () => api<Wallet>('/wallet')
export const getImages = () => api<Image[]>('/images')
export const uploadImage = (body: { name: string; base64: string }) => api<Image>('/images/upload', body)
export const updateImage = (id: string, favorite: boolean) => api(`/images/${id}`, { favorite }, 'PATCH')
export const deleteImage = (id: string) => api(`/images/${id}`, undefined, 'DELETE')
export const createConversation = (characterId: string) => api<{ id: string }>('/conversations', { characterId })
export const updateConversation = (id: string, body: Partial<Conversation>) => api<Conversation>(`/conversations/${id}`, body, 'PATCH')
export const deleteConversation = (id: string) => api(`/conversations/${id}`, undefined, 'DELETE')
export const sendMessage = (id: string, content: string, clientMessageId: string) => api<{ reply: string; messageId: string; chargedCredits: number; balance: number }>(`/conversations/${id}/messages`, { content, clientMessageId })
export const getMessageRequest = (id: string, requestId: string) => api<{ status: string }>(`/conversations/${id}/messages/requests/${encodeURIComponent(requestId)}`)
export const getWorldBooks = (characterId?: string) => api<WorldBook[]>('/world-books' + (characterId ? '?characterId=' + encodeURIComponent(characterId) : ''))
export const saveWorldBook = (body: Partial<WorldBook>) => api<WorldBook>('/world-books', body)
export const updateWorldBook = (id: string, body: Partial<WorldBook>) => api<WorldBook>(`/world-books/${id}`, body, 'PATCH')
export const deleteWorldBook = (id: string) => api(`/world-books/${id}`, undefined, 'DELETE')
export const createCreatorCharacter = (body: Partial<Character>) => api<Character>('/creator/characters', body)
export const getCreatorCharacters = () => api<Character[]>('/creator/characters')
export const publishCreatorCharacter = (id: string) => api<Character>(`/creator/characters/${id}/publish`)
export const getKnowledge = (characterId?: string) => api<Knowledge[]>('/knowledge' + (characterId ? '?characterId=' + encodeURIComponent(characterId) : ''))
export const saveKnowledge = (body: Partial<Knowledge>) => api<Knowledge>('/knowledge', body)
export const updateKnowledge = (id: string, body: Partial<Knowledge>) => api<Knowledge>(`/knowledge/${id}`, body, 'PATCH')
export const deleteKnowledge = (id: string) => api(`/knowledge/${id}`, undefined, 'DELETE')
export const getPersonas = () => api<Persona[]>('/personas')
export const savePersona = (body: Partial<Persona>) => api<Persona>('/personas', body)
export const updatePersona = (id: string, body: Partial<Persona>) => api<Persona>(`/personas/${id}`, body, 'PATCH')
export const deletePersona = (id: string) => api(`/personas/${id}`, undefined, 'DELETE')
export const getConversationState = (id: string) => api<ConversationState>(`/conversations/${id}/state`)
export const saveConversationState = (id: string, body: Partial<ConversationState>) => api<ConversationState>(`/conversations/${id}/state`, body, 'PUT')
export const undoLastRound = (id: string) => api(`/conversations/${id}/undo`)
export const refreshGreeting = (id: string) => api<{ greeting: string }>(`/conversations/${id}/refresh-greeting`)
export const getStoryOptions = (id: string) => api<{ options: string[]; relationship: number }>(`/conversations/${id}/options`)
export const getStatusBar = (id: string) => api<{ relationship: number; status: Record<string, any>; label: string }>(`/conversations/${id}/status-bar`)
export const getSocial = (id: string) => api<Social>(`/characters/${id}/social`)
export const toggleLike = (id: string, liked: boolean) => api<Social>(`/characters/${id}/like`, { liked })
export const postComment = (id: string, content: string) => api<Social>(`/characters/${id}/comments`, { content })
export const getTasks = () => api<Task[]>('/tasks')
export const checkin = () => api<{ streak: number; reward: number }>('/checkin')
export const claimTask = (id: string) => api<{ reward: number; balance: number }>(`/tasks/${id}/claim`)
export const createOrder = (planId: string) => api<Order>('/orders', { planId })
export const cancelOrder = (id: string) => api(`/orders/${id}/cancel`, {})
export const getNovels = (mine = false) => api<Novel[]>('/novels?mine=' + mine)
export const getNovel = (id: string) => api<any>('/novels/' + id)
export const saveNovel = (body: Partial<Novel>) => api<Novel>('/novels', body)
export const saveChapter = (id: string, body: any) => api<any>(`/novels/${id}/chapters`, body)
export const getInvite = () => api<Invite>('/invite')
export const bindInvite = (code: string) => api('/invite/bind', { code })
export const redeemInvite = () => api('/invite/redeem')
export const getMiniapps = (characterId?: string) => api<any[]>('/miniapps' + (characterId ? '?characterId=' + characterId : ''))
export const saveMiniapp = (body: any) => api<any>('/miniapps', body)
export const getGameSaves = (id: string) => api<any[]>(`/miniapps/${id}/saves`)
export const saveGame = (id: string, slot: string, data: any) => api(`/miniapps/${id}/saves/${encodeURIComponent(slot)}`, { data }, 'PUT')
export async function streamMessage(id: string, content: string, clientMessageId: string, signal: AbortSignal, onDelta: (text: string) => void, onPhase?: (phase: 'thinking' | 'responding') => void) {
  const token = localStorage.getItem('user_token')
  const response = await fetch(API + `/conversations/${id}/messages/stream`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ content, clientMessageId }), signal: AbortSignal.any([signal, AbortSignal.timeout(110000)]) })
  if (!response.ok) {
    if (response.status === 401) { localStorage.removeItem('user_token'); window.dispatchEvent(new Event('user-session-expired')) }
    const data = await response.json().catch(() => null); throw new Error(data?.message || `请求失败（${response.status}）`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务没有返回流式响应')
  for await (const frame of readSse(response.body)) {
    const data = JSON.parse(frame.data)
    if (frame.event === 'error') throw new Error(data.message || '生成失败')
    if (frame.event === 'delta' && typeof data.text === 'string') onDelta(data.text)
    if (frame.event === 'status' && ['thinking', 'responding'].includes(data.phase)) onPhase?.(data.phase)
    if (frame.event === 'done') return data as { reply: string; messageId: string; chargedCredits: number; balance: number }
  }
  throw new Error('连接中断，请检查聊天记录后重试')
}
import { readSse } from '@ai-character/data/src/sse'
