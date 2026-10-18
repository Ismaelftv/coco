/**
 * Cliente mínimo do protocolo PostgreSQL v3 — TEMPORÁRIO.
 *
 * Existe apenas porque o registo npm estava inacessível e o `pg`
 * (node-postgres) não pôde ser instalado. Substituir por `pg` assim que
 * possível (docs/04-pendentes.md); o resto do código depende só da
 * interface em `db.ts`.
 *
 * Âmbito deliberadamente pequeno:
 *  - só o protocolo estendido (Parse/Bind/Execute) com parâmetros enviados
 *    separadamente do SQL — não existe nenhuma via para interpolar valores;
 *  - autenticação SCRAM-SHA-256 (e MD5/trust para compatibilidade);
 *  - TLS opcional via SSLRequest;
 *  - resultados em formato texto, convertidos para os tipos usados no projeto.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: false | ConnectionOptions;
  connectTimeoutMs: number;
  /** Parâmetros de sessão enviados no arranque (ex.: statement_timeout). */
  runtimeParams: Record<string, string>;
}

export interface PgResult<R> {
  rows: R[];
  rowCount: number;
  command: string;
}

export class PgError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly detail: string | undefined,
    readonly constraint: string | undefined,
  ) {
    super(message);
    this.name = 'PgError';
  }
}

export function parseDatabaseUrl(url: string): Omit<PgConfig, 'connectTimeoutMs' | 'runtimeParams'> {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL deve começar por postgres://');
  }
  const sslmode = u.searchParams.get('sslmode') ?? 'disable';
  let ssl: false | ConnectionOptions = false;
  if (sslmode === 'require') ssl = { rejectUnauthorized: false };
  else if (sslmode === 'verify-full') ssl = { rejectUnauthorized: true, servername: u.hostname };
  else if (sslmode !== 'disable') throw new Error(`sslmode não suportado: ${sslmode}`);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || 'postgres',
    ssl,
  };
}

// ---------- Serialização ----------

class Writer {
  private chunks: Buffer[] = [];
  int16(n: number) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    this.chunks.push(b);
    return this;
  }
  int32(n: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    this.chunks.push(b);
    return this;
  }
  cstring(s: string) {
    this.chunks.push(Buffer.from(s, 'utf8'), Buffer.from([0]));
    return this;
  }
  bytes(b: Buffer) {
    this.chunks.push(b);
    return this;
  }
  /** Mensagem com tipo de 1 byte e comprimento. */
  message(type: string): Buffer {
    const body = Buffer.concat(this.chunks);
    const head = Buffer.alloc(5);
    head.write(type, 0, 'ascii');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  }
  /** Mensagem sem tipo (arranque, SSLRequest). */
  untyped(): Buffer {
    const body = Buffer.concat(this.chunks);
    const head = Buffer.alloc(4);
    head.writeInt32BE(body.length + 4);
    return Buffer.concat([head, body]);
  }
}

export type PgParam = string | number | bigint | boolean | Date | Buffer | null | undefined | object;

export function serializeParam(v: PgParam): Buffer | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('Número não finito como parâmetro');
    return Buffer.from(String(v));
  }
  if (typeof v === 'bigint') return Buffer.from(v.toString());
  if (typeof v === 'boolean') return Buffer.from(v ? 't' : 'f');
  if (v instanceof Date) return Buffer.from(v.toISOString());
  if (Buffer.isBuffer(v)) return Buffer.from(`\\x${v.toString('hex')}`);
  return Buffer.from(JSON.stringify(v), 'utf8');
}

// OIDs de tipos convertidos; os restantes ficam como texto.
const OID = { bool: 16, bytea: 17, int8: 20, int2: 21, int4: 23, json: 114, float4: 700, float8: 701, timestamp: 1114, timestamptz: 1184, jsonb: 3802 } as const;

export function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case OID.bool:
      return text === 't';
    case OID.int2:
    case OID.int4:
    case OID.float4:
    case OID.float8:
      return Number(text);
    case OID.int8: {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case OID.json:
    case OID.jsonb:
      return JSON.parse(text);
    case OID.timestamptz:
    case OID.timestamp:
      if (oid === OID.timestamp) return new Date(`${text.replace(' ', 'T')}Z`);
      // "2026-10-18 12:34:56.789+00" → offset ISO completo "+00:00"
      return new Date(text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    case OID.bytea:
      return text.startsWith('\\x') ? Buffer.from(text.slice(2), 'hex') : Buffer.from(text, 'binary');
    default:
      return text;
  }
}

// ---------- Ligação ----------

interface Field {
  name: string;
  oid: number;
}

interface Pending {
  resolve(r: PgResult<Record<string, unknown>>): void;
  reject(e: Error): void;
  fields: Field[];
  rows: Record<string, unknown>[];
  command: string;
  error: PgError | null;
}

export class PgConnection {
  private socket!: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private onReady: (() => void) | null = null;
  private onFatal: ((e: Error) => void) | null = null;
  private scram: { nonce: string; firstBare: string; serverSignature?: Buffer } | null = null;
  closed = false;
  /** Último erro fatal (a ligação deixa de ser utilizável). */
  broken: Error | null = null;

  private constructor(private readonly config: PgConfig) {}

  static async connect(config: PgConfig): Promise<PgConnection> {
    const conn = new PgConnection(config);
    await conn.open();
    return conn;
  }

  private open(): Promise<void> {
    const { host, port, ssl, connectTimeoutMs } = this.config;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket?.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('Tempo limite ao ligar ao PostgreSQL')), connectTimeoutMs);
      const raw = netConnect({ host, port });
      raw.once('error', fail);

      const startup = (sock: Socket) => {
        this.socket = sock;
        sock.on('data', (d: Buffer) => this.onData(d));
        sock.on('error', (e) => this.fatal(e));
        sock.on('close', () => this.fatal(new Error('Ligação ao PostgreSQL fechada')));
        this.onReady = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        this.onFatal = fail;
        const w = new Writer().int32(196608).cstring('user').cstring(this.config.user).cstring('database').cstring(this.config.database);
        for (const [k, v] of Object.entries(this.config.runtimeParams)) w.cstring(k).cstring(v);
        sock.write(w.cstring('').untyped());
      };

      raw.once('connect', () => {
        if (!ssl) return startup(raw);
        raw.write(new Writer().int32(80877103).untyped());
        raw.once('data', (b: Buffer) => {
          if (b[0] !== 0x53 /* S */) return fail(new Error('O servidor recusou TLS'));
          const secure = tlsConnect({ ...ssl, socket: raw });
          secure.once('secureConnect', () => startup(secure));
          secure.once('error', fail);
        });
      });
    });
  }

  private fatal(e: Error) {
    if (this.closed && !this.pending) return;
    this.broken ??= e;
    this.closed = true;
    const f = this.onFatal;
    this.onFatal = null;
    f?.(e);
    if (this.pending) {
      this.pending.reject(e);
      this.pending = null;
    }
  }

  private onData(data: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]!);
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) return;
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      try {
        this.handle(type, body);
      } catch (e) {
        this.fatal(e as Error);
        this.socket.destroy();
        return;
      }
    }
  }

  private handle(type: string, body: Buffer) {
    switch (type) {
      case 'R':
        return this.handleAuth(body);
      case 'E': {
        const err = parseError(body);
        if (this.pending) this.pending.error = err;
        else this.fatal(err);
        return;
      }
      case 'Z': {
        if (this.onReady) {
          const r = this.onReady;
          this.onReady = null;
          this.onFatal = null;
          r();
          return;
        }
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        if (p.error) p.reject(p.error);
        else p.resolve({ rows: p.rows, rowCount: p.rows.length || rowCountFrom(p.command), command: p.command.split(' ')[0] ?? '' });
        return;
      }
      case 'T': {
        if (!this.pending) return;
        const n = body.readInt16BE(0);
        let off = 2;
        const fields: Field[] = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off);
          const name = body.toString('utf8', off, end);
          off = end + 1;
          const oid = body.readInt32BE(off + 6);
          off += 18;
          fields.push({ name, oid });
        }
        this.pending.fields = fields;
        return;
      }
      case 'D': {
        const p = this.pending;
        if (!p) return;
        const n = body.readInt16BE(0);
        let off = 2;
        const row: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const len = body.readInt32BE(off);
          off += 4;
          const f = p.fields[i]!;
          if (len === -1) row[f.name] = null;
          else {
            row[f.name] = parseValue(f.oid, body.toString('utf8', off, off + len));
            off += len;
          }
        }
        p.rows.push(row);
        return;
      }
      case 'C':
        if (this.pending) this.pending.command = body.toString('utf8', 0, body.length - 1);
        return;
      // ParseComplete, BindComplete, NoData, ParameterStatus, BackendKeyData, Notice, Notification
      default:
        return;
    }
  }

  private handleAuth(body: Buffer) {
    const code = body.readInt32BE(0);
    const { user, password } = this.config;
    if (code === 0) return; // AuthenticationOk
    if (code === 3) {
      if (!this.config.ssl) throw new Error('Palavra-passe em claro sem TLS recusada');
      this.socket.write(new Writer().cstring(password).message('p'));
      return;
    }
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = createHash('md5').update(password + user).digest('hex');
      const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.socket.write(new Writer().cstring(`md5${outer}`).message('p'));
      return;
    }
    if (code === 10) {
      const mechanisms = body.subarray(4).toString('utf8').split('\0');
      if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error('Servidor não oferece SCRAM-SHA-256');
      const nonce = randomBytes(18).toString('base64');
      const firstBare = `n=*,r=${nonce}`;
      this.scram = { nonce, firstBare };
      const first = Buffer.from(`n,,${firstBare}`);
      this.socket.write(new Writer().cstring('SCRAM-SHA-256').int32(first.length).bytes(first).message('p'));
      return;
    }
    if (code === 11) {
      const s = this.scram;
      if (!s) throw new Error('SCRAM fora de ordem');
      const serverFirst = body.subarray(4).toString('utf8');
      const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
      const r = attrs.r ?? '';
      if (!r.startsWith(s.nonce)) throw new Error('SCRAM: nonce do servidor inválido');
      const salt = Buffer.from(attrs.s ?? '', 'base64');
      const iterations = Number(attrs.i);
      if (!Number.isInteger(iterations) || iterations < 4096) throw new Error('SCRAM: iterações inválidas');
      const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
      const clientKey = createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = createHash('sha256').update(clientKey).digest();
      const finalBare = `c=biws,r=${r}`;
      const authMessage = `${s.firstBare},${serverFirst},${finalBare}`;
      const clientSig = createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) proof[i] = clientKey[i]! ^ clientSig[i]!;
      const serverKey = createHmac('sha256', salted).update('Server Key').digest();
      s.serverSignature = createHmac('sha256', serverKey).update(authMessage).digest();
      this.socket.write(new Writer().bytes(Buffer.from(`${finalBare},p=${proof.toString('base64')}`)).message('p'));
      return;
    }
    if (code === 12) {
      const verifier = body.subarray(4).toString('utf8');
      const v = Buffer.from(verifier.startsWith('v=') ? verifier.slice(2) : '', 'base64');
      const expected = this.scram?.serverSignature;
      // Autenticação mútua: garante que falamos com um servidor que conhece a palavra-passe.
      if (!expected || v.length !== expected.length || !timingSafeEqual(v, expected)) {
        throw new Error('SCRAM: assinatura do servidor inválida');
      }
      this.scram = null;
      return;
    }
    throw new Error(`Método de autenticação PostgreSQL não suportado (${code})`);
  }

  /** Executa uma instrução com parâmetros $1..$n. Uma de cada vez por ligação. */
  query<R = Record<string, unknown>>(sql: string, params: readonly PgParam[] = []): Promise<PgResult<R>> {
    const run = () =>
      new Promise<PgResult<R>>((resolve, reject) => {
        if (this.closed) return reject(this.broken ?? new Error('Ligação fechada'));
        this.pending = {
          resolve: resolve as Pending['resolve'],
          reject,
          fields: [],
          rows: [],
          command: '',
          error: null,
        };
        const bind = new Writer().cstring('').cstring('').int16(0).int16(params.length);
        for (const p of params) {
          const b = serializeParam(p as PgParam);
          if (b === null) bind.int32(-1);
          else bind.int32(b.length).bytes(b);
        }
        bind.int16(0);
        this.socket.write(
          Buffer.concat([
            new Writer().cstring('').cstring(sql).int16(0).message('P'),
            bind.message('B'),
            new Writer().bytes(Buffer.from('P\0')).message('D'),
            new Writer().cstring('').int32(0).message('E'),
            new Writer().message('S'),
          ]),
        );
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Protocolo simples (várias instruções, sem parâmetros). Reservado às
   * migrações, cujo SQL vem de ficheiros do repositório — nunca de entradas.
   */
  exec(sql: string): Promise<PgResult<Record<string, unknown>>> {
    const run = () =>
      new Promise<PgResult<Record<string, unknown>>>((resolve, reject) => {
        if (this.closed) return reject(this.broken ?? new Error('Ligação fechada'));
        this.pending = { resolve, reject, fields: [], rows: [], command: '', error: null };
        this.socket.write(new Writer().cstring(sql).message('Q'));
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.socket.end(new Writer().message('X'), () => resolve());
      setTimeout(resolve, 500);
    });
    this.socket.destroy();
  }
}

function rowCountFrom(command: string): number {
  const last = Number(command.split(' ').at(-1));
  return Number.isFinite(last) ? last : 0;
}

function parseError(body: Buffer): PgError {
  const fields: Record<string, string> = {};
  let off = 0;
  while (off < body.length && body[off] !== 0) {
    const key = String.fromCharCode(body[off]!);
    const end = body.indexOf(0, off + 1);
    fields[key] = body.toString('utf8', off + 1, end);
    off = end + 1;
  }
  return new PgError(fields.M ?? 'Erro do PostgreSQL', fields.C, fields.D, fields.n);
}
