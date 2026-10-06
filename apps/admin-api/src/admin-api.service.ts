import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { PlatformStore } from '@ai-character/data'
@Injectable()
export class AdminApiService extends PlatformStore implements OnModuleDestroy {
  async onModuleDestroy() { await this.close() }
}
