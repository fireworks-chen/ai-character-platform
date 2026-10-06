import { Module } from '@nestjs/common'
import { AdminApiController } from './admin-api.controller'
import { AdminApiService } from './admin-api.service'
import { AdminGuard } from './admin-guard'
import { AdminAuthController } from './auth.controller'
@Module({ controllers: [AdminApiController, AdminAuthController], providers: [AdminApiService, AdminGuard] })
export class AdminApiModule {}
