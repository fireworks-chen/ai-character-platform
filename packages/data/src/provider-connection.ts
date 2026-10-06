import { DomainError } from './index'

export function normalizeProviderBaseUrl(value: string) {
  let parsed: URL
  try { parsed = new URL(value.trim()) } catch { throw new DomainError(400, '请输入 HTTP/HTTPS 服务地址，API Key 应填写在密钥栏') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new DomainError(400, '服务地址需为 HTTP/HTTPS，不能包含账号、查询参数或锚点')
  if (parsed.pathname === '/') parsed.pathname = '/v1'
  return parsed.toString().replace(/\/+$/, '')
}

export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(normalizeProviderBaseUrl(baseUrl) + '/models', { headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      const reasons: Record<number, string> = { 401: '供应商认证失败，请检查 API Key', 403: '供应商拒绝访问，请检查密钥权限', 404: '模型列表接口不存在，请检查服务地址及 /v1 路径', 429: '供应商限制了请求，请稍后重试' }
      throw new DomainError(502, `${reasons[response.status] || '供应商模型列表请求失败'}（HTTP ${response.status}）`)
    }
    const raw = await response.text()
    if (response.headers.get('content-type')?.includes('text/html') || /^\s*</.test(raw)) throw new DomainError(502, '服务地址返回了网页，没有返回模型列表；请填写 API 地址（通常以 /v1 结尾）')
    let payload: any
    try { payload = JSON.parse(raw) } catch { throw new DomainError(502, '供应商模型列表不是有效 JSON，请检查 API 地址') }
    if (!Array.isArray(payload?.data)) throw new DomainError(502, '供应商模型列表格式无效，需要 OpenAI 兼容的 /models 接口')
    return [...new Set<string>(payload.data.map((item: any) => item?.id).filter((id: any) => typeof id === 'string' && id.trim() && id.length <= 160))].sort()
  } catch (error: any) {
    if (error instanceof DomainError) throw error
    if (error.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(error.cause?.code)) throw new DomainError(502, '连接供应商超时，请检查服务地址和网络后重试')
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code)) throw new DomainError(502, '供应商域名解析失败，请检查域名或本机 DNS')
    if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.cause?.code)) throw new DomainError(502, '供应商 HTTPS 证书验证失败')
    throw new DomainError(502, '无法连接供应商，请检查服务地址和网络')
  }
}
