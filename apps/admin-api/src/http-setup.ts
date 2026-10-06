import { ArgumentsHost, Catch, ExceptionFilter, HttpException, INestApplication } from '@nestjs/common'
import { DomainError } from '@ai-character/data'
@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse()
    const status = error instanceof DomainError ? error.status : error instanceof HttpException ? error.getStatus() : 503
    const message = error instanceof DomainError ? error.message : error instanceof HttpException ? (error.getResponse() as any)?.message || error.message : '服务暂时不可用，请稍后重试'
    if (!(error instanceof DomainError) && !(error instanceof HttpException)) console.error('API operation failed:', error.code || error.name)
    response.status(status).json({ statusCode: status, message })
  }
}
export function setupHttp(app: INestApplication) {
  app.useGlobalFilters(new ApiErrors())
  const attempts = new Map<string, { count: number; until: number }>()
  app.use((req: any, res: any, next: () => void) => {
    if (!req.path.endsWith('/login') && !req.path.endsWith('/register')) return next()
    const key = req.ip; const current = attempts.get(key)
    if (current && current.until > Date.now()) { current.count++; if (current.count > 30) return res.status(429).json({ message: '登录尝试过多，请 15 分钟后再试' }) }
    else { for (const [ip, attempt] of attempts) if (attempt.until < Date.now()) attempts.delete(ip); attempts.set(key, { count: 1, until: Date.now() + 900000 }) }
    next()
  })
}
