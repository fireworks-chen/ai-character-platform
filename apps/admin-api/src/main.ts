import 'dotenv/config'
import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AdminApiModule } from './admin-api.module'
import { AdminApiService } from './admin-api.service'
import { loadEnvironment } from '@ai-character/data'
import { setupHttp } from './http-setup'
loadEnvironment()

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AdminApiModule)
  app.useBodyParser('json', { limit: '12mb' })
  await app.get(AdminApiService).ready
  setupHttp(app)
  app.setGlobalPrefix('api/v1')
  const origins = (process.env.ADMIN_CORS_ORIGINS || 'http://localhost:4174,http://127.0.0.1:4174').split(',').map(value => value.trim()).filter(Boolean)
  app.enableCors({ credentials: true, origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => !origin || origins.includes(origin) ? callback(null, true) : callback(new Error('Origin is not allowed by CORS')) })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  await app.listen(Number(process.env.ADMIN_API_PORT || 3100))
}
bootstrap()
