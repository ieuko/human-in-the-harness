import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessError, HumanRuntime } from "../src/index.js";
import type { SubmitRequest } from "../src/index.js";

function fixture(t: { after: (fn: () => void) => void }, clock?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), "hith-test-"));
  const path = join(dir, "requests.sqlite");
  const runtime = new HumanRuntime(path, clock ? { clock } : {});
  t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, path };
}

const request: SubmitRequest = {
  idempotencyKey: "work-1", requester: "agent", recipient: "human", prompt: "依頼内容を確認してください。",
};
const errorCode = (code: string) => (error: unknown) => error instanceof HarnessError && error.code === code;

test("依頼と途中の質問を再起動後にも回収し、任意の構造化した結果を得られる", t => {
  const { runtime, path } = fixture(t);
  const created = runtime.submit({ ...request, responseSchema: { type: "object", properties: { next: { type: "string" } }, required: ["next"], additionalProperties: false } });
  runtime.respond(created.id, { inputId: "question", actor: "human", kind: "question", revision: 1, payload: "どの条件を優先しますか？" });
  runtime.close();
  const reopened = new HumanRuntime(path);
  t.after(() => reopened.close());
  assert.equal(reopened.get(created.id).status, "in_progress");
  assert.equal(reopened.events({ requestId: created.id })[1]!.input!.payload, "どの条件を優先しますか？");
  const revised = reopened.amend(created.id, { expectedRevision: 1, context: { priority: "継続可能性" } });
  const stale = reopened.respond(created.id, { inputId: "old-answer", actor: "human", kind: "answer", revision: 1, payload: { next: "古い条件" } });
  assert.equal(stale.input.disposition, "stale");
  assert.equal(stale.request.status, "pending");
  const result = reopened.respond(created.id, { inputId: "answer", actor: "human", kind: "answer", revision: revised.revision, payload: { next: "次のモデルを呼び出す" } });
  assert.equal(result.request.status, "completed");
  assert.deepEqual(reopened.get(created.id).result, { next: "次のモデルを呼び出す" });
});

test("依頼と回答の再送は効果を重複させず、同じキーの異なる内容を検出する", t => {
  const { runtime } = fixture(t);
  const a = runtime.submit({ ...request, context: { b: 2, a: 1 } });
  const b = runtime.submit({ ...request, context: { a: 1, b: 2 } });
  assert.equal(a.id, b.id);
  assert.throws(() => runtime.submit({ ...request, prompt: "別の内容" }), errorCode("IDEMPOTENCY_CONFLICT"));
  const input = { inputId: "same", actor: "human", kind: "answer" as const, revision: 1, payload: false };
  runtime.respond(a.id, input);
  assert.equal(runtime.respond(a.id, input).input.disposition, "accepted");
  assert.equal(runtime.get(a.id).result, false);
  assert.equal(runtime.events({ requestId: a.id }).length, 2);
  assert.throws(() => runtime.respond(a.id, { ...input, payload: true }), errorCode("IDEMPOTENCY_CONFLICT"));
});

test("締切後と取り消し後の入力は記録するが、元の結果に適用しない", t => {
  let time = new Date("2026-11-07T10:00:00Z");
  const { runtime } = fixture(t, () => time);
  const expiring = runtime.submit({ ...request, deadlineAt: "2026-11-07T10:01:00Z" });
  time = new Date("2026-11-07T10:02:00Z");
  const late = runtime.respond(expiring.id, { inputId: "late", actor: "human", kind: "answer", revision: 1, payload: "遅れて到着" });
  assert.equal(late.request.status, "expired");
  assert.equal(late.input.disposition, "late");
  assert.equal(late.request.result, null);
  assert.deepEqual(runtime.events({ requestId: expiring.id }).map(e => e.type), ["request.created", "request.expired", "input.received"]);
  const other = runtime.submit({ ...request, idempotencyKey: "cancel" });
  runtime.cancel(other.id);
  runtime.cancel(other.id);
  const afterCancel = runtime.respond(other.id, { inputId: "after-cancel", actor: "human", kind: "answer", revision: 1, payload: 42 });
  assert.equal(afterCancel.request.status, "cancelled");
  assert.equal(afterCancel.input.disposition, "late");
  assert.equal(runtime.events({ requestId: other.id }).filter(e => e.type === "request.cancelled").length, 1);
});

test("辞退は結果として保存し、他の未解決の依頼を止めない", t => {
  const { runtime } = fixture(t);
  const one = runtime.submit(request);
  const two = runtime.submit({ ...request, idempotencyKey: "work-2" });
  runtime.respond(one.id, { inputId: "decline", actor: "human", kind: "decline", revision: 1, payload: "今回は対応できません。" });
  assert.equal(runtime.get(one.id).status, "declined");
  assert.equal(runtime.get(two.id).status, "pending");
  assert.equal(runtime.list({ status: "pending" }).length, 1);
});

test("回答スキーマと宛先を検査し、不正な回答で依頼を完了させない", t => {
  const { runtime } = fixture(t);
  const item = runtime.submit({ ...request, responseSchema: { type: "integer", minimum: 1 } });
  assert.throws(() => runtime.respond(item.id, { inputId: "wrong", actor: "other", kind: "answer", revision: 1, payload: 3 }), errorCode("WRONG_RECIPIENT"));
  assert.throws(() => runtime.respond(item.id, { inputId: "invalid", actor: "human", kind: "answer", revision: 1, payload: "3" }), errorCode("INVALID_RESPONSE"));
  assert.equal(runtime.get(item.id).status, "pending");
  assert.equal(runtime.events().length, 1);
  assert.throws(() => runtime.submit({ ...request, idempotencyKey: "bad-schema", responseSchema: { type: "made-up" } }), errorCode("INVALID_SCHEMA"));
});

test("イベントのカーソルと範囲を使って、再接続後の入力だけを取得できる", t => {
  const { runtime } = fixture(t);
  const first = runtime.submit({ ...request, scope: "session-a" });
  runtime.submit({ ...request, idempotencyKey: "other", scope: "session-b" });
  const initial = runtime.events({ scope: "session-a", limit: 1 });
  runtime.respond(first.id, { inputId: "progress", actor: "human", kind: "progress", revision: 1, payload: "確認中" });
  const updates = runtime.events({ scope: "session-a", after: initial[0]!.sequence });
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.input!.kind, "progress");
  assert.equal(runtime.events({ scope: "session-a", after: updates[0]!.sequence }).length, 0);
  assert.throws(() => runtime.events({ after: -1 }), errorCode("INVALID_ARGUMENT"));
});
