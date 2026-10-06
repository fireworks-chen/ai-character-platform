import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common'
import { DomainError } from '@ai-character/data'
import { AppService } from './app.service'
import { UserGuard } from './user-guard'
@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly store: AppService) {}
  @Get('characters') characters() { return this.store.characters(true) }
  @Get('characters/:id') character(@Param('id') id: string) { return this.store.getCharacter(id) }
  @Get('plans') plans() { return this.store.plans(true) }
  @Post('payments/callback') callback(@Body() body: any) { return this.store.paymentCallback(body) }
}
@Controller()
@UseGuards(UserGuard)
export class UserController {
  constructor(@Inject(AppService) private readonly store: AppService) {}
  @Get('me') me(@Req() req: any) { return this.store.me(req.actor) }
  @Patch('me') profile(@Req() req: any, @Body() body: any) { return this.store.profile(req.actor, body) }
  @Post('auth/logout') logout(@Req() req: any) { return this.store.logout(req.token, req.actor) }
  @Get('conversations') conversations(@Req() req: any) { return this.store.conversations(req.actor) }
  @Post('conversations') create(@Req() req: any, @Body() body: any) { return this.store.createConversation(req.actor, body.characterId) }
  @Patch('conversations/:id') update(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.updateConversation(req.actor, id, body) }
  @Delete('conversations/:id') delete(@Req() req: any, @Param('id') id: string) { return this.store.deleteConversation(req.actor, id) }
  @Get('conversations/:id/messages') messages(@Req() req: any, @Param('id') id: string) { return this.store.messages(req.actor, id) }
  @Post('conversations/:id/messages') message(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.sendMessage(req.actor, id, body.content, body.clientMessageId) }
  @Get('conversations/:id/messages/requests/:requestId') requestState(@Req() req: any, @Param('id') id: string, @Param('requestId') requestId: string) { return this.store.messageRequest(req.actor, id, requestId) }
  @Post('conversations/:id/messages/stream')
  async stream(@Req() req: any, @Res() res: any, @Param('id') id: string, @Body() body: any) {
    const controller = new AbortController()
    const closed = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', closed)
    res.socket?.setNoDelay(true)
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    const event = async (name: string, data: any) => {
      controller.signal.throwIfAborted()
      const writable = res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      res.flush?.()
      if (!writable) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { res.off('drain', drained); controller.signal.removeEventListener('abort', aborted) }
        const drained = () => { cleanup(); resolve() }; const aborted = () => { cleanup(); reject(new Error('Connection closed')) }
        res.once('drain', drained); controller.signal.addEventListener('abort', aborted, { once: true })
        if (controller.signal.aborted) aborted()
      })
    }
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': keepalive\n\n') }, 15000)
    try {
      const result = await this.store.sendMessage(req.actor, id, body.content, body.clientMessageId, { signal: controller.signal, delta: text => event('delta', { text }), phase: phase => event('status', { phase }) })
      await event('done', result)
    } catch (error) {
      if (!controller.signal.aborted) await event('error', { statusCode: error instanceof DomainError ? error.status : 502, message: error instanceof DomainError ? error.message : '生成失败，预留积分已退回' }).catch(() => {})
    } finally { clearInterval(heartbeat); res.off('close', closed); res.end() }
  }
  @Get('wallet') wallet(@Req() req: any) { return this.store.wallet(req.actor) }
  @Get('favorites') favorites(@Req() req: any) { return this.store.favoriteCharacters(req.actor) }
  @Patch('favorites/:id') favorite(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.favoriteCharacter(req.actor, id, body.favorite) }
  @Get('images') images(@Req() req: any) { return this.store.images(req.actor) }
  @Post('images') image(@Req() req: any, @Body() body: any) { return this.store.generateImage(req.actor, body) }
  @Post('images/upload') upload(@Req() req: any, @Body() body: any) { return this.store.uploadImage(req.actor, body) }
  @Patch('images/:id') favoriteImage(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.updateImage(req.actor, id, body.favorite) }
  @Delete('images/:id') deleteImage(@Req() req: any, @Param('id') id: string) { return this.store.deleteImage(req.actor, id) }
  @Get('orders') orders(@Req() req: any) { return this.store.orders(req.actor) }
  @Post('orders') order(@Req() req: any, @Body() body: any) { return this.store.createOrder(req.actor, body.planId) }
  @Post('orders/:id/cancel') cancel(@Req() req: any, @Param('id') id: string) { return this.store.cancelOrder(req.actor, id) }
  @Get('characters/:id/meta') characterMeta(@Param('id') id: string) { return this.store.characterMeta(id) }
  @Put('characters/:id/meta') saveCharacterMeta(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveCharacterMeta(req.actor, id, body) }
  @Get('world-books') worldBooks(@Req() req: any, @Query('characterId') characterId?: string) { return this.store.worldBooks(req.actor, characterId) }
  @Post('world-books') saveWorldBook(@Req() req: any, @Body() body: any) { return this.store.saveWorldBook(req.actor, body) }
  @Patch('world-books/:id') updateWorldBook(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveWorldBook(req.actor, body, id) }
  @Delete('world-books/:id') deleteWorldBook(@Req() req: any, @Param('id') id: string) { return this.store.deleteWorldBook(req.actor, id) }
  @Get('knowledge') knowledge(@Req() req: any, @Query('characterId') characterId?: string) { return this.store.knowledge(req.actor, characterId) }
  @Post('knowledge') saveKnowledge(@Req() req: any, @Body() body: any) { return this.store.saveKnowledge(req.actor, body) }
  @Patch('knowledge/:id') updateKnowledge(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveKnowledge(req.actor, body, id) }
  @Delete('knowledge/:id') deleteKnowledge(@Req() req: any, @Param('id') id: string) { return this.store.deleteKnowledge(req.actor, id) }
  @Get('personas') personas(@Req() req: any) { return this.store.personas(req.actor) }
  @Post('personas') savePersona(@Req() req: any, @Body() body: any) { return this.store.savePersona(req.actor, body) }
  @Patch('personas/:id') updatePersona(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.savePersona(req.actor, body, id) }
  @Delete('personas/:id') deletePersona(@Req() req: any, @Param('id') id: string) { return this.store.deletePersona(req.actor, id) }
  @Get('conversations/:id/state') conversationState(@Req() req: any, @Param('id') id: string) { return this.store.conversationState(req.actor, id) }
  @Put('conversations/:id/state') saveConversationState(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveConversationState(req.actor, id, body) }
  @Post('conversations/:id/undo') undo(@Req() req: any, @Param('id') id: string) { return this.store.undoLastRound(req.actor, id) }
  @Post('conversations/:id/refresh-greeting') refreshGreeting(@Req() req: any, @Param('id') id: string) { return this.store.refreshGreeting(req.actor, id) }
  @Get('conversations/:id/options') options(@Req() req: any, @Param('id') id: string) { return this.store.storyOptions(req.actor, id) }
  @Get('conversations/:id/status-bar') statusBar(@Req() req: any, @Param('id') id: string) { return this.store.statusBar(req.actor, id) }
  @Get('characters/:id/social') social(@Req() req: any, @Param('id') id: string) { return this.store.social(req.actor, id) }
  @Post('characters/:id/like') like(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.toggleLike(req.actor, id, body.liked) }
  @Post('characters/:id/comments') comment(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.comment(req.actor, id, body.content) }
  @Post('users/:id/follow') follow(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.toggleFollow(req.actor, id, body.followed) }
  @Get('users/:id') author(@Req() req: any, @Param('id') id: string) { return this.store.author(req.actor, id) }
  @Post('checkin') checkin(@Req() req: any) { return this.store.checkin(req.actor) }
  @Get('tasks') tasks(@Req() req: any) { return this.store.tasks(req.actor) }
  @Post('tasks/:id/claim') claimTask(@Req() req: any, @Param('id') id: string) { return this.store.claimTask(req.actor, id) }
  @Get('novels') novels(@Req() req: any, @Query('mine') mine?: string) { return this.store.novels(req.actor, mine === 'true') }
  @Get('novels/:id') novel(@Req() req: any, @Param('id') id: string) { return this.store.novel(req.actor, id) }
  @Post('novels') saveNovel(@Req() req: any, @Body() body: any) { return this.store.saveNovel(req.actor, body) }
  @Patch('novels/:id') updateNovel(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveNovel(req.actor, body, id) }
  @Post('novels/:id/chapters') saveChapter(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveChapter(req.actor, id, body) }
  @Get('invite') invite(@Req() req: any) { return this.store.invite(req.actor) }
  @Post('invite/bind') bindInvite(@Req() req: any, @Body() body: any) { return this.store.bindInvite(req.actor, body.code) }
  @Post('invite/redeem') redeem(@Req() req: any) { return this.store.redeemCommission(req.actor) }
  @Get('miniapps') miniapps(@Req() req: any, @Query('characterId') characterId?: string) { return this.store.miniapps(req.actor, characterId) }
  @Post('miniapps') saveMiniapp(@Req() req: any, @Body() body: any) { return this.store.saveMiniapp(req.actor, body) }
  @Patch('miniapps/:id') updateMiniapp(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveMiniapp(req.actor, body, id) }
  @Get('miniapps/:id/saves') games(@Req() req: any, @Param('id') id: string) { return this.store.games(req.actor, id) }
  @Put('miniapps/:id/saves/:slot') saveGame(@Req() req: any, @Param('id') id: string, @Param('slot') slot: string, @Body() body: any) { return this.store.saveGame(req.actor, id, slot, body.data) }
  @Get('creator/characters') creatorCharacters(@Req() req: any) { return this.store.creatorCharacters(req.actor) }
  @Post('creator/characters') createCreatorCharacter(@Req() req: any, @Body() body: any) { return this.store.saveCharacter(req.actor, null, { ...body, published: false }) }
  @Patch('creator/characters/:id') updateCreatorCharacter(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.store.saveCharacter(req.actor, id, body) }
  @Post('creator/characters/:id/publish') publishCreatorCharacter(@Req() req: any, @Param('id') id: string) { return this.store.saveCharacter(req.actor, id, { published: true }) }
}
