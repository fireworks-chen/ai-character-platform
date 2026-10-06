import 'dotenv/config'
import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { AppService } from './app.service'
import { loadEnvironment } from '@ai-character/data'
import { setupHttp } from './http-setup'
loadEnvironment()

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  app.useBodyParser('json', { limit: '12mb' })
  await app.get(AppService).ready
  setupHttp(app)
  app.setGlobalPrefix('api/v1')
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173,http://localhost:4174,http://127.0.0.1:4173,http://127.0.0.1:4174').split(',').map(value => value.trim()).filter(Boolean)
  app.enableCors({
    credentials: true,
    origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
      return callback(new Error('Origin is not allowed by CORS'))
    },
  })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  await app.listen(process.env.PORT || 3000)
}
bootstrap()
