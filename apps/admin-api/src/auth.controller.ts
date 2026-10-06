import { Body, Controller, Inject, Post } from '@nestjs/common'
import { AdminApiService } from './admin-api.service'
@Controller('admin')
export class AdminAuthController {
  constructor(@Inject(AdminApiService) private readonly store: AdminApiService) {}
  @Post('login') login(@Body() body: any) { return this.store.login(body.email, body.password, true) }
}
