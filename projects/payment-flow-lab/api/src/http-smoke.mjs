// Run against a started backend: node src/http-smoke.mjs
import assert from 'node:assert/strict';
const base=process.env.API_URL||'http://127.0.0.1:3000';
const key=crypto.randomUUID();
async function call(path,body,headers={}){const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
assert.equal((await call('/health')).status,200);
const data={reference:'HTTP smoke test',amount:25990};
const a=await call('/payments',data,{'Idempotency-Key':key});assert.equal(a.status,201);
const b=await call('/payments',data,{'Idempotency-Key':key});assert.equal(b.body.payment.id,a.body.payment.id);assert.equal(b.body.replayed,true);
assert.equal((await call('/payments',{...data,amount:1},{'Idempotency-Key':key})).status,409);
const sim=await call('/payments/'+a.body.payment.id+'/simulate',{status:'approved'});assert.equal(sim.status,201);
let found;for(let i=0;i<40;i++){found=(await call('/payments')).body.find(x=>x.id===a.body.payment.id);if(found.status==='approved')break;await new Promise(r=>setTimeout(r,200));}assert.equal(found.status,'approved');
const replay=await call('/webhooks/provider',sim.body.event,{'X-Signature':sim.body.signature});assert.equal(replay.body.duplicate,true);
assert.equal((await call('/webhooks/provider',sim.body.event,{'X-Signature':'0'.repeat(64)})).status,401);
assert.equal((await call('/payments/'+a.body.payment.id+'/audit')).body.events.length,1);
console.log('HTTP smoke: creación, idempotencia, conflicto, worker, firma y webhook repetido OK');
