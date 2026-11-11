import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { Database, SQL } from './db';
type Outcome = 'approved' | 'rejected';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException('Se esperaba un objeto JSON'); return v as Record<string, unknown>; }
function text(v: unknown, name: string, max = 100): string { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new BadRequestException(`${name} inválido`); return v.trim(); }
function outcome(v: unknown): Outcome { if (v !== 'approved' && v !== 'rejected') throw new BadRequestException('Estado inválido'); return v; }
export class Payments {
  readonly changes = new Subject<{ data: unknown }>();
  constructor(readonly db: Database, private readonly secret: string) {}
  list() { return this.db.query('SELECT id, reference, amount, currency, status, created_at, updated_at FROM payments ORDER BY created_at DESC, id DESC LIMIT 100').then(x => x.rows); }
  async get(id: string, tx: SQL = this.db) { const p = (await tx.query('SELECT id, reference, amount, currency, status, created_at, updated_at FROM payments WHERE id=$1', [id])).rows[0]; if (!p) throw new NotFoundException('Pago no encontrado'); return p; }
  async create(body: unknown, key: unknown) {
    const b = object(body); const reference = text(b.reference, 'Referencia', 80); const k = text(key, 'Idempotency-Key', 120);
    if (!Number.isSafeInteger(b.amount) || Number(b.amount) < 1 || Number(b.amount) > 10000000) throw new BadRequestException('Monto entero entre 1 y 10.000.000 CLP');
    const amount = Number(b.amount), fingerprint = hash({reference, amount});
    const result = await this.db.transaction(async tx => {
      const id = randomUUID();
      const inserted = await tx.query(`INSERT INTO payments(id,idempotency_key,fingerprint,reference,amount) VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`, [id,k,fingerprint,reference,amount]);
      const row = (await tx.query('SELECT id,fingerprint FROM payments WHERE idempotency_key=$1', [k])).rows[0];
      if (row.fingerprint !== fingerprint) throw new ConflictException('Esta clave ya se usó con otros datos');
      return { payment: await this.get(row.id, tx), replayed: !inserted.rows.length };
    });
    this.changes.next({data:{type:'payment.created', paymentId:result.payment.id}}); return result;
  }
  sign(raw: Buffer): string { return createHmac('sha256', this.secret).update(raw).digest('hex'); }
  verify(raw: Buffer | undefined, signature: unknown) {
    if (!raw || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new UnauthorizedException('Firma inválida');
    if (!timingSafeEqual(Buffer.from(signature,'hex'), Buffer.from(this.sign(raw),'hex'))) throw new UnauthorizedException('Firma inválida');
  }
  async apply(body: unknown, tx: SQL) {
    const b = object(body), id = text(b.eventId,'eventId'), paymentId = text(b.paymentId,'paymentId'), status = outcome(b.status);
    const fingerprint = hash({id,paymentId,status});
    // Serialize transitions per payment; event IDs also have a database uniqueness constraint.
    const locked = (await tx.query('SELECT id,status FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!locked) throw new NotFoundException('Pago no encontrado');
    const existing = (await tx.query('SELECT fingerprint FROM webhook_events WHERE id=$1',[id])).rows[0];
    if (existing) { if (existing.fingerprint !== fingerprint) throw new ConflictException('eventId reutilizado con otro contenido'); return {duplicate:true, payment:await this.get(paymentId,tx)}; }
    if (locked.status !== 'pending') throw new ConflictException('El pago ya tiene un estado final');
    const inserted = await tx.query('INSERT INTO webhook_events(id,payment_id,fingerprint,outcome) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id', [id,paymentId,fingerprint,status]);
    if (!inserted.rows.length) throw new ConflictException('eventId reutilizado con otro contenido');
    await tx.query('UPDATE payments SET status=$1,updated_at=now() WHERE id=$2',[status,paymentId]);
    return {duplicate:false,payment:await this.get(paymentId,tx)};
  }
  async webhook(body: unknown, raw: Buffer | undefined, signature: unknown) {
    this.verify(raw, signature); const result = await this.db.transaction(tx => this.apply(body,tx));
    this.changes.next({data:{type:'payment.updated',paymentId:result.payment.id}}); return result;
  }
  async simulate(id: string, body: unknown) {
    const b = object(body), status = outcome(b.status);
    return this.db.transaction(async tx => {
      const p = await this.get(id,tx); if (p.status !== 'pending') throw new ConflictException('El pago ya terminó');
      const event = {eventId:randomUUID(), paymentId:id, status}, raw = Buffer.from(JSON.stringify(event));
      await tx.query('INSERT INTO outbox(id,payment_id,payload,next_at) VALUES($1,$2,$3,$4)', [event.eventId,id,raw.toString(), new Date(Date.now()+1200)]);
      return {event, signature:this.sign(raw), queued:true};
    });
  }
  async tick() {
    // Claim + application + acknowledgement share a single transaction. No event is lost on restart.
    const result = await this.db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM outbox WHERE processed_at IS NULL AND attempts < 5 AND next_at <= now() ORDER BY next_at FOR UPDATE SKIP LOCKED LIMIT 1')).rows[0];
      if (!row) return false;
      // SAVEPOINT keeps a failed SQL statement from aborting the retry bookkeeping transaction.
      await tx.query('SAVEPOINT process_event');
      try {
        await this.apply(JSON.parse(row.payload),tx);
        await tx.query('UPDATE outbox SET processed_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1',[row.id]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT process_event');
        await tx.query('UPDATE outbox SET attempts=attempts+1,last_error=$1,next_at=$2 WHERE id=$3',[e instanceof Error ? e.message : 'Error',new Date(Date.now()+1000*2**row.attempts),row.id]);
      }
      return true;
    });
    if (result) this.changes.next({data:{type:'queue.processed'}}); return result;
  }
  async audit(id: string) { await this.get(id); return {events:(await this.db.query('SELECT id,outcome,created_at FROM webhook_events WHERE payment_id=$1 ORDER BY created_at',[id])).rows, queue:(await this.db.query('SELECT id,attempts,next_at,processed_at,last_error FROM outbox WHERE payment_id=$1 ORDER BY next_at',[id])).rows}; }
}
