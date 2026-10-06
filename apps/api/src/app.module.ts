import { Module } from '@nestjs/common'
import { AppController, UserController } from './app.controller'
import { AppService } from './app.service'
import { AuthController } from './auth.controller'
import { UserGuard } from './user-guard'

@Module({ controllers: [AppController, UserController, AuthController], providers: [AppService, UserGuard] })
export class AppModule {}
