import { Body, Controller, Inject, Post } from '@nestjs/common'
import { AppService } from './app.service'
@Controller('auth')
export class AuthController {
  constructor(@Inject(AppService) private readonly store: AppService) {}
  @Post('login') login(@Body() body: any) { return this.store.login(body.email, body.password) }
  @Post('register') register(@Body() body: any) { return this.store.register(body) }
}
