import 'reflect-metadata';
import { Body, Controller, Get, Headers, Module, Param, Post, Req, Sse } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db';
import { Payments } from './payments';
let payments: Payments;
@Controller('api')
class Api {
  @Get('health') health() { return {status:'ok',mode:process.env.DATABASE_URL?'postgresql':'pglite',demo:true}; }
  @Get('payments') list() { return payments.list(); }
  @Post('payments') create(@Body() b: unknown, @Headers('idempotency-key') key: string) { return payments.create(b,key); }
  @Get('payments/:id/audit') audit(@Param('id') id: string) { return payments.audit(id); }
  @Post('payments/:id/simulate') simulate(@Param('id') id: string,@Body() b: unknown) { return payments.simulate(id,b); }
  @Post('webhooks/provider') webhook(@Body() b: unknown, @Req() req: {rawBody?:Buffer}, @Headers('x-signature') sig: string) { return payments.webhook(b,req.rawBody,sig); }
  @Sse('events') events() { return payments.changes.asObservable(); }
}
@Module({controllers:[Api]}) class AppModule {}
async function main() {
  const db = await openDatabase();
  const secret = process.env.WEBHOOK_SECRET || randomBytes(32).toString('hex');
  payments = new Payments(db,secret);
  const app = await NestFactory.create(AppModule,{rawBody:true});
  let working = false;
  const timer = setInterval(async () => {
    if (working) return; working = true;
    try { await payments.tick(); } catch(e) { console.error('Worker:', e instanceof Error? e.message:e); } finally { working = false; }
  },500);
  const stop = async () => { clearInterval(timer); await app.close(); while(working) await new Promise(r=>setTimeout(r,20)); await db.close(); process.exit(0); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  await app.listen(Number(process.env.PORT || 3000),'0.0.0.0');
}
main().catch(e => {console.error(e);process.exit(1);});
