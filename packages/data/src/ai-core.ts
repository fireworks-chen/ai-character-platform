import { normalizeProviderBaseUrl } from './provider-connection'
export async function generateChat(body: { baseUrl: string; apiKey: string; model: string; messages: Array<{ role: string; content: string }> }, options?: { stream: boolean; signal: AbortSignal }) {
  body = { ...body, baseUrl: normalizeProviderBaseUrl(body.baseUrl) }
  const stream = options?.stream ?? false
  const signal = options ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000)
  if (process.env.AI_ENGINE === 'direct') return fetch(body.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + body.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: body.model, messages: body.messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }), signal })
  const core = process.env.SILLYTAVERN_URL || 'http://127.0.0.1:8000'
  const auth = 'Basic ' + Buffer.from((process.env.SILLYTAVERN_USERNAME || 'core') + ':' + (process.env.SILLYTAVERN_PASSWORD || '')).toString('base64')
  const csrfResponse = await fetch(core + '/csrf-token', { headers: { authorization: auth }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
  if (!csrfResponse.ok) throw new Error('SillyTavern core authorization failed')
  const { token } = await csrfResponse.json() as { token: string }
  const cookies = csrfResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  // Core's custom OpenAI-compatible source forwards include_usage and auth headers.
  // Its ordinary OpenAI source currently drops stream_options from the request.
  const connection = stream ? { chat_completion_source: 'custom', custom_url: body.baseUrl, custom_include_headers: JSON.stringify({ Authorization: 'Bearer ' + body.apiKey }), custom_include_body: JSON.stringify({ stream_options: { include_usage: true } }) } : { chat_completion_source: 'openai', reverse_proxy: body.baseUrl, proxy_password: body.apiKey }
  return fetch(core + '/api/backends/chat-completions/generate', { method: 'POST', headers: { authorization: auth, cookie: cookies, 'x-csrf-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ ...connection, model: body.model, messages: body.messages, max_tokens: 1024, temperature: 0.8, top_p: 1, stream }), signal })
}
