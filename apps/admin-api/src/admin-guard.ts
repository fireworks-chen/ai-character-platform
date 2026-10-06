import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Inject } from '@nestjs/common'
import { AdminApiService } from './admin-api.service'
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AdminApiService) private readonly store: AdminApiService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest()
    const token = request.headers.authorization?.replace(/^Bearer /i, '') || request.headers['x-admin-token']
    const actor = await this.store.authenticate(token)
    if (!['admin', 'operator', 'auditor'].includes(actor.role)) throw new ForbiddenException('无管理端权限')
    if (!['GET', 'HEAD'].includes(request.method) && actor.role !== 'admin') {
      const ownAccount = request.path.endsWith('/admin/logout') || request.path.endsWith('/admin/me')
      if (!ownAccount && (actor.role !== 'operator' || !request.path.includes('/characters'))) throw new ForbiddenException('此操作需要超级管理员权限')
    }
    request.actor = actor; request.token = token
    return true
  }
}
