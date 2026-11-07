import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { HarnessError, inputKinds, statuses } from "./types.js";
import type { AmendRequest, HumanEvent, HumanInput, HumanRequest, InputReceipt, JsonObject, JsonValue, RespondInput, SubmitRequest } from "./types.js";

const terminal = new Set(["completed", "declined", "cancelled", "expired", "failed"]);

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new HarnessError("INVALID_ARGUMENT", `${field}には空でない文字列が必要です。`);
}

function object(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("INVALID_ARGUMENT", `${field}にはオブジェクトが必要です。`);
}

function integer(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new HarnessError("INVALID_ARGUMENT", `${field}には${minimum}以上の整数が必要です。`);
}

// 再送の比較がオブジェクトのキー順に依存しないようにする。
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (current: unknown): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current !== "object" || !current) throw new HarnessError("INVALID_JSON", "JSONとして保存できない値です。");
    if (ancestors.has(current)) throw new HarnessError("INVALID_JSON", "循環参照は保存できません。");
    ancestors.add(current);
    let result: JsonValue;
    if (Array.isArray(current)) result = Array.from(current, visit);
    else {
      const proto = Object.getPrototypeOf(current);
      if (proto !== Object.prototype && proto !== null) throw new HarnessError("INVALID_JSON", "通常のJSONオブジェクトが必要です。");
      const sorted: JsonObject = Object.create(null);
      for (const key of Object.keys(current).sort()) sorted[key] = visit((current as Record<string, unknown>)[key]);
      result = sorted;
    }
    ancestors.delete(current);
    return result;
  };
  return JSON.stringify(visit(value));
}

function deadline(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HarnessError("INVALID_ARGUMENT", "deadlineAtにはタイムゾーン付きの日時、またはnullが必要です。");
  }
  return new Date(value).toISOString();
}

export interface RuntimeOptions { clock?: () => Date }
export interface ListOptions { recipient?: string; scope?: string; status?: HumanRequest["status"]; limit?: number }
export interface EventOptions { after?: number; requestId?: string; scope?: string; limit?: number }

/** 人間の役割や作業手順を固定しない、ローカルの永続的な依頼ストア。 */
export class HumanRuntime {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly validators = new Map<string, ValidateFunction>();
  private closed = false;

  constructor(databasePath: string, options: RuntimeOptions = {}) {
    text(databasePath, "databasePath");
    if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.clock = options.clock ?? (() => new Date());
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      this.transaction(() => {
        const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if (version > 1) throw new HarnessError("UNSUPPORTED_DATABASE", "この実装より新しいデータベース形式です。");
        if (version === 0) this.db.exec(`
          CREATE TABLE requests (
            id TEXT PRIMARY KEY,
            requester TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            recipient TEXT NOT NULL,
            scope TEXT,
            status TEXT NOT NULL,
            deadline TEXT,
            data TEXT NOT NULL,
            UNIQUE(requester, idempotency_key)
          );
          CREATE INDEX request_lookup ON requests(scope, recipient, status);
          CREATE TABLE inputs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL REFERENCES requests(id),
            fingerprint TEXT NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT NOT NULL REFERENCES requests(id),
            scope TEXT,
            data TEXT NOT NULL
          );
          CREATE INDEX event_lookup ON events(scope, sequence);
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }

  submit(input: SubmitRequest): HumanRequest {
    object(input, "依頼");
    text(input.idempotencyKey, "idempotencyKey");
    text(input.requester, "requester");
    text(input.recipient, "recipient");
    text(input.prompt, "prompt");
    if (input.scope !== undefined) text(input.scope, "scope");
    if (input.correlation !== undefined) object(input.correlation, "correlation");
    if (input.responseSchema !== undefined) this.validator(input.responseSchema);
    const normalized = {
      requester: input.requester, recipient: input.recipient, prompt: input.prompt,
      context: input.context ?? null, responseSchema: input.responseSchema ?? null,
      scope: input.scope ?? null, correlation: input.correlation ?? {}, deadlineAt: deadline(input.deadlineAt),
    };
    const fingerprint = canonicalJson(normalized);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT id, fingerprint FROM requests WHERE requester = ? AND idempotency_key = ?").get(input.requester, input.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new HarnessError("IDEMPOTENCY_CONFLICT", "同じ受付キーに異なる依頼が指定されています。");
        return this.expireOne(this.read(String(prior.id)));
      }
      const now = this.now();
      const request: HumanRequest = { ...JSON.parse(fingerprint), id: randomUUID(), revision: 1, status: "pending", createdAt: now, updatedAt: now, result: null };
      this.db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        request.id, input.requester, input.idempotencyKey, fingerprint, request.recipient, request.scope, request.status, request.deadlineAt, JSON.stringify(request),
      );
      this.event("request.created", request);
      return this.expireOne(request);
    });
  }

  get(id: string): HumanRequest {
    text(id, "依頼ID");
    return this.transaction(() => this.expireOne(this.read(id)));
  }

  list(options: ListOptions = {}): HumanRequest[] {
    const limit = this.limit(options.limit);
    if (options.status !== undefined && !statuses.includes(options.status)) throw new HarnessError("INVALID_ARGUMENT", "不明な状態です。");
    return this.transaction(() => {
      this.expireDue();
      const conditions: string[] = [];
      const values: (string | number)[] = [];
      for (const [column, value] of [["recipient", options.recipient], ["scope", options.scope], ["status", options.status]] as const) {
        if (value !== undefined) { text(value, column); conditions.push(`${column} = ?`); values.push(value); }
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      return this.db.prepare(`SELECT data FROM requests ${where} ORDER BY rowid LIMIT ?`).all(...values, limit).map(row => JSON.parse(String(row.data)) as HumanRequest);
    });
  }

  respond(id: string, input: RespondInput): InputReceipt {
    text(id, "依頼ID");
    object(input, "入力");
    text(input.inputId, "inputId");
    text(input.actor, "actor");
    integer(input.revision, "revision", 1);
    if (!inputKinds.includes(input.kind)) throw new HarnessError("INVALID_ARGUMENT", "不明な入力の種類です。");
    const fingerprint = canonicalJson({ requestId: id, inputId: input.inputId, actor: input.actor, kind: input.kind, revision: input.revision, payload: input.payload });
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT fingerprint, data FROM inputs WHERE id = ?").get(input.inputId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new HarnessError("IDEMPOTENCY_CONFLICT", "同じ入力IDに異なる内容が指定されています。");
        return { input: JSON.parse(String(prior.data)) as HumanInput, request: this.expireOne(this.read(id)) };
      }
      let request = this.expireOne(this.read(id));
      if (input.actor !== request.recipient) throw new HarnessError("WRONG_RECIPIENT", "この依頼の宛先と入力者が一致しません。");
      const disposition = terminal.has(request.status) ? "late" : input.revision !== request.revision ? "stale" : "accepted";
      if (disposition === "accepted" && input.kind === "answer" && request.responseSchema) {
        const validate = this.validator(request.responseSchema);
        if (!validate(input.payload)) throw new HarnessError("INVALID_RESPONSE", `回答形式が一致しません: ${this.ajv.errorsText(validate.errors)}`);
      }
      const received: HumanInput = { ...JSON.parse(fingerprint), disposition, createdAt: this.now() };
      if (disposition === "accepted") {
        const next = { answer: "completed", decline: "declined", failure: "failed", question: "in_progress", progress: "in_progress" } as const;
        request = { ...request, status: next[input.kind], updatedAt: received.createdAt };
        if (terminal.has(request.status)) request.result = input.payload;
        this.save(request);
      }
      this.db.prepare("INSERT INTO inputs VALUES (?, ?, ?, ?)").run(input.inputId, id, fingerprint, JSON.stringify(received));
      this.event("input.received", request, received);
      return { input: received, request };
    });
  }

  amend(id: string, change: AmendRequest): HumanRequest {
    text(id, "依頼ID");
    object(change, "変更内容");
    integer(change.expectedRevision, "expectedRevision", 1);
    if (change.prompt !== undefined) text(change.prompt, "prompt");
    if (change.context !== undefined) canonicalJson(change.context);
    if (change.responseSchema !== undefined && change.responseSchema !== null) this.validator(change.responseSchema);
    const changedDeadline = change.deadlineAt === undefined ? undefined : deadline(change.deadlineAt);
    return this.transaction(() => {
      const request = this.expireOne(this.read(id));
      if (terminal.has(request.status)) throw new HarnessError("REQUEST_CLOSED", "終了した依頼は変更できません。必要に応じて新しい依頼を作成してください。");
      if (request.revision !== change.expectedRevision) throw new HarnessError("REVISION_CONFLICT", "依頼の版が変わっています。最新の依頼を取得してください。");
      const updated: HumanRequest = {
        ...request, revision: request.revision + 1, status: "pending", updatedAt: this.now(),
        prompt: change.prompt ?? request.prompt,
        context: change.context === undefined ? request.context : change.context,
        responseSchema: change.responseSchema === undefined ? request.responseSchema : change.responseSchema,
        deadlineAt: changedDeadline === undefined ? request.deadlineAt : changedDeadline,
      };
      this.save(updated);
      this.event("request.amended", updated);
      return this.expireOne(updated);
    });
  }

  cancel(id: string): HumanRequest {
    text(id, "依頼ID");
    return this.transaction(() => {
      const request = this.expireOne(this.read(id));
      if (terminal.has(request.status)) return request;
      const cancelled: HumanRequest = { ...request, status: "cancelled", updatedAt: this.now() };
      this.save(cancelled);
      this.event("request.cancelled", cancelled);
      return cancelled;
    });
  }

  events(options: EventOptions = {}): HumanEvent[] {
    const after = options.after ?? 0;
    integer(after, "after");
    const limit = this.limit(options.limit);
    return this.transaction(() => {
      this.expireDue();
      const conditions = ["sequence > ?"];
      const values: (number | string)[] = [after];
      for (const [column, value] of [["request_id", options.requestId], ["scope", options.scope]] as const) {
        if (value !== undefined) { text(value, column); conditions.push(`${column} = ?`); values.push(value); }
      }
      return this.db.prepare(`SELECT sequence, data FROM events WHERE ${conditions.join(" AND ")} ORDER BY sequence LIMIT ?`).all(...values, limit)
        .map(row => ({ ...JSON.parse(String(row.data)), sequence: Number(row.sequence) }) as HumanEvent);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private now(): string { return this.clock().toISOString(); }

  private read(id: string): HumanRequest {
    const row = this.db.prepare("SELECT data FROM requests WHERE id = ?").get(id);
    if (!row) throw new HarnessError("NOT_FOUND", "依頼が見つかりません。");
    return JSON.parse(String(row.data)) as HumanRequest;
  }

  private save(request: HumanRequest): void {
    this.db.prepare("UPDATE requests SET status = ?, deadline = ?, data = ? WHERE id = ?").run(request.status, request.deadlineAt, JSON.stringify(request), request.id);
  }

  private event(type: HumanEvent["type"], request: HumanRequest, input: HumanInput | null = null): void {
    const event = { requestId: request.id, type, createdAt: this.now(), request, input };
    this.db.prepare("INSERT INTO events(request_id, scope, data) VALUES (?, ?, ?)").run(request.id, request.scope, JSON.stringify(event));
  }

  private expireOne(request: HumanRequest): HumanRequest {
    if (!terminal.has(request.status) && request.deadlineAt && request.deadlineAt <= this.now()) {
      request = { ...request, status: "expired", updatedAt: this.now() };
      this.save(request);
      this.event("request.expired", request);
    }
    return request;
  }

  private expireDue(): void {
    for (const row of this.db.prepare("SELECT data FROM requests WHERE status IN ('pending', 'in_progress') AND deadline <= ?").all(this.now())) {
      this.expireOne(JSON.parse(String(row.data)) as HumanRequest);
    }
  }

  private limit(value = 100): number {
    integer(value, "limit", 1);
    if (value > 1000) throw new HarnessError("INVALID_ARGUMENT", "limitの上限は1000です。");
    return value;
  }

  private validator(schema: JsonObject): ValidateFunction {
    object(schema, "responseSchema");
    const key = canonicalJson(schema);
    const cached = this.validators.get(key);
    if (cached) return cached;
    try { const validate = this.ajv.compile(schema); this.validators.set(key, validate); return validate; }
    catch (error) { throw new HarnessError("INVALID_SCHEMA", `回答スキーマが不正です: ${(error as Error).message}`); }
  }
}
