import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { AdminApiService } from './admin-api.service'
import { AdminGuard } from './admin-guard'
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminApiController {
  constructor(@Inject(AdminApiService) private readonly store: AdminApiService) {}
  @Get('me') me(@Req() req: any) { return this.store.me(req.actor) }
  @Patch('me') profile(@Req() req: any, @Body() body: any) { return this.store.profile(req.actor, body) }
  @Post('logout') logout(@Req() req: any) { return this.store.logout(req.token, req.actor) }
  @Get('overview') overview() { return this.store.overview() }
  @Get('characters') characters() { return this.store.characters() }
  @Post('characters') createCharacter(@Req() req: any, @Body() body: any) { return this.store.saveCharacter(req.actor, null, body) }
  @Post('characters/import') importCharacter(@Req() req: any, @Body() body: any) { return this.store.importCharacter(req.actor, body) }
  @Post('characters/cover/upload') uploadCover(@Req() req: any, @Body() body: any) { return this.store.uploadCharacterCover(req.actor, body) }
  @Get('characters/cover/images') coverImages(@Req() req: any) { return this.store.images(req.actor) }
  @Get('characters/cover/models') coverModels() { return this.store.coverModels() }
  @Post('characters/cover/generate') generateCover(@Req() req: any, @Body() body: any) { return this.store.generateCharacterCover(req.actor, body) }
  @Get('characters/:id/export') exportCharacter(@Param('id') id: string) { return this.store.exportCharacter(id) }
  @Patch('characters/:id') updateCharacter(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveCharacter(req.actor, id, body) }
  @Delete('characters/:id') deleteCharacter(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.deleteCharacter(req.actor, id, body.reason) }
  @Get('provider') provider() { return this.store.provider() }
  @Patch('provider') providerUpdate(@Req() req: any, @Body() body: any) { return this.store.updateProvider(req.actor, body) }
  @Get('models') models() { return this.store.models() }
  @Post('models') createModel(@Req() req: any, @Body() body: any) { return this.store.saveModel(req.actor, null, body) }
  @Post('models/discover') discoverModels(@Req() req: any, @Body() body: any) { return this.store.discoverModels(req.actor, body) }
  @Patch('models/:id') updateModel(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveModel(req.actor, id, body) }
  @Delete('models/:id') deleteModel(@Req() req: any, @Param('id') id: string) { return this.store.deleteModel(req.actor, id) }
  @Post('models/:id/test') testModel(@Req() req: any, @Param('id') id: string) { return this.store.testModel(req.actor, id) }
  @Post('billing/estimate') estimate(@Body() body: any) { return this.store.estimate(body) }
  @Get('users') users() { return this.store.users() }
  @Post('users') createUser(@Req() req: any, @Body() body: any) { return this.store.createUser(req.actor, body) }
  @Patch('users/:id') updateUser(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.updateUser(req.actor, id, body) }
  @Delete('users/:id') deleteUser(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.deleteUser(req.actor, id, body.reason) }
  @Post('users/:id/credits') credits(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.adjustCredits(req.actor, id, body) }
  @Get('ledger') ledger() { return this.store.ledgers() }
  @Get('logs') logs() { return this.store.logs() }
  @Get('orders') orders() { return this.store.orders() }
  @Get('plans') plans() { return this.store.plans() }
  @Post('plans') createPlan(@Req() req: any, @Body() body: any) { return this.store.savePlan(req.actor, null, body) }
  @Patch('plans/:id') updatePlan(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.savePlan(req.actor, id, body) }
  @Delete('plans/:id') deletePlan(@Req() req: any, @Param('id') id: string) { return this.store.deletePlan(req.actor, id) }
  @Get('payment') payment() { return this.store.paymentConfig() }
  @Patch('payment') paymentUpdate(@Req() req: any, @Body() body: any) { return this.store.savePayment(req.actor, body) }
}
