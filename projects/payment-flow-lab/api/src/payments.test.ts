import 'reflect-metadata';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Database } from './db';
import { Payments } from './payments';
let db: Database, service: Payments;
before(async()=>{db=await openDatabase(true);service=new Payments(db,'test-secret');});
after(async()=>db.close());
const create=(key:string)=>service.create({reference:'Orden demo',amount:15000},key);
test('idempotencia concurrente crea una sola orden; otro monto genera conflicto',async()=>{
 const rows=await Promise.all(Array.from({length:8},()=>create('same')));
 assert.equal(new Set(rows.map(x=>x.payment.id)).size,1);
 assert.equal(rows.filter(x=>!x.replayed).length,1);
 await assert.rejects(()=>service.create({reference:'Orden demo',amount:2},'same'),{status:409});
});
test('valida monto y clave',async()=>{
 for(const amount of [0,-1,1.5,'100',10000001]) await assert.rejects(()=>service.create({reference:'demo',amount},'invalid'),{status:400});
 await assert.rejects(()=>service.create({reference:'demo',amount:1},undefined),{status:400});
});
test('rechaza firma inválida; procesa webhook una vez y bloquea otra transición final',async()=>{
 const {payment:p}=await create('webhook');
 const body={eventId:'evt-1',paymentId:p.id,status:'approved'}, raw=Buffer.from(JSON.stringify(body));
 await assert.rejects(()=>service.webhook(body,raw,'0'.repeat(64)),{status:401});
 assert.equal((await service.get(p.id)).status,'pending');
 assert.equal((await service.webhook(body,raw,service.sign(raw))).duplicate,false);
 assert.equal((await service.webhook(body,raw,service.sign(raw))).duplicate,true);
 const other={...body,eventId:'evt-2',status:'rejected'}, bytes=Buffer.from(JSON.stringify(other));
 await assert.rejects(()=>service.webhook(other,bytes,service.sign(bytes)),{status:409});
 const audit=await service.audit(p.id);assert.equal(audit.events.length,1);
});
test('eventId no puede reutilizarse con otro contenido',async()=>{
 const {payment:p}=await create('collision');
 const b={eventId:'evt-1',paymentId:p.id,status:'approved'}, raw=Buffer.from(JSON.stringify(b));
 await assert.rejects(()=>service.webhook(b,raw,service.sign(raw)),{status:409});
 assert.equal((await service.get(p.id)).status,'pending');
});
test('outbox sobrevive nueva instancia y se procesa sin duplicar efectos',async()=>{
 const {payment:p}=await create('queued'); await service.simulate(p.id,{status:'rejected'});
 await db.query('UPDATE outbox SET next_at=$1 WHERE payment_id=$2',[new Date(Date.now()-1000),p.id]);
 const restarted=new Payments(db,'test-secret'); assert.equal(await restarted.tick(),true);
 assert.equal((await restarted.get(p.id)).status,'rejected'); assert.equal(await restarted.tick(),false);
 const audit=await restarted.audit(p.id);assert.equal(audit.events.length,1);assert.equal(audit.queue[0].attempts,1);
});
test('evento incompatible se reintenta y conserva el error en la cola',async()=>{
 const {payment:p}=await create('retry');await service.simulate(p.id,{status:'approved'});await service.simulate(p.id,{status:'rejected'});
 await db.query('UPDATE outbox SET next_at=$1 WHERE payment_id=$2',[new Date(Date.now()-1000),p.id]);
 await service.tick(); await service.tick();
 const audit=await service.audit(p.id);assert.equal(audit.events.length,1);
 assert.equal(audit.queue.filter(x=>x.last_error).length,1);
});
