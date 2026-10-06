import { CanActivate, ExecutionContext, Injectable, Inject } from '@nestjs/common'
import { AppService } from './app.service'
@Injectable()
export class UserGuard implements CanActivate {
  constructor(@Inject(AppService) private readonly store: AppService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest()
    request.token = request.headers.authorization?.replace(/^Bearer /i, '')
    request.actor = await this.store.authenticate(request.token)
    return true
  }
}
