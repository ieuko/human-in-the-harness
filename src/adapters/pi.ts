import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { HumanRuntime } from "../core/runtime.js";
import { HarnessError, inputKinds } from "../core/types.js";
import type { HumanEvent, HumanRequest, InputKind, JsonObject, JsonValue } from "../core/types.js";

export interface PiAdapterOptions { databasePath?: string }

const messageType = "hith-event";
const scopeFor = (ctx: ExtensionContext) => `pi:${ctx.sessionManager.getSessionId()}`;

function belongs(request: HumanRequest, ctx: ExtensionContext): boolean {
  if (request.scope !== scopeFor(ctx)) return false;
  const anchor = request.correlation.originEntryId;
  return anchor === null || typeof anchor === "string" && ctx.sessionManager.getBranch().some(entry => entry.id === anchor);
}

function assertBelongs(request: HumanRequest, ctx: ExtensionContext): void {
  if (!belongs(request, ctx)) throw new HarnessError("WRONG_EXECUTION", "この依頼は現在のセッション・分岐に属していません。");
}

/** 依頼の役割や待機範囲を固定せず、piのツールと人間側の操作を接続する。 */
export function registerHumanExtension(pi: ExtensionAPI, options: PiAdapterOptions = {}): void {
  function using<T>(ctx: ExtensionContext, fn: (runtime: HumanRuntime) => T): T {
    const path = options.databasePath ?? process.env.HITH_DATABASE ?? resolve(ctx.cwd, "var/hith.sqlite");
    const runtime = new HumanRuntime(path);
    try { return fn(runtime); } finally { runtime.close(); }
  }

  pi.registerTool({
    name: "human_submit", label: "人間への依頼",
    description: "人間への任意の依頼を永続化して受付IDを返す。人間の回答は後から到着する。",
    promptSnippet: "人間への非同期な依頼を登録する",
    promptGuidelines: [
      "human_submitの成功は依頼の受付を意味する。人間の回答を得たとは扱わない。",
      "human_getを繰り返して待機しない。回答に依存しない処理を進めるか、ユーザーの次の入力を待つ。",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1 }), recipient: Type.Optional(Type.String({ minLength: 1 })),
      context: Type.Optional(Type.Unknown()), responseSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      deadlineAt: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const origin = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall" && part.id === toolCallId));
      const request = using(ctx, runtime => runtime.submit({
        idempotencyKey: `${scopeFor(ctx)}:${toolCallId}`, requester: scopeFor(ctx), recipient: params.recipient ?? "human", prompt: params.prompt,
        scope: scopeFor(ctx), correlation: { sessionId: ctx.sessionManager.getSessionId(), originEntryId: origin?.id ?? ctx.sessionManager.getLeafId(), toolCallId },
        ...(params.context === undefined ? {} : { context: params.context as JsonValue }),
        ...(params.responseSchema === undefined ? {} : { responseSchema: params.responseSchema as JsonObject }),
        ...(params.deadlineAt === undefined ? {} : { deadlineAt: params.deadlineAt }),
      }));
      return { content: [{ type: "text", text: JSON.stringify({ receipt: "registered", request }) }], details: { requestId: request.id } };
    },
  });

  for (const operation of ["get", "cancel"] as const) pi.registerTool({
    name: `human_${operation}`, label: operation === "get" ? "人間への依頼の状態" : "人間への依頼の取り消し",
    description: operation === "get" ? "現在の実行に属する依頼の状態と結果を取得する。" : "現在の実行に属する依頼を取り消す。既に得た結果や人間の行為は巻き戻さない。",
    promptSnippet: operation === "get" ? "依頼の状態と結果を取得する" : "依頼を取り消す",
    parameters: Type.Object({ requestId: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = using(ctx, runtime => {
        const current = runtime.get(params.requestId);
        assertBelongs(current, ctx);
        return operation === "cancel" ? runtime.cancel(current.id) : current;
      });
      return { content: [{ type: "text", text: JSON.stringify(request) }], details: { requestId: request.id } };
    },
  });

  pi.registerTool({
    name: "human_amend", label: "人間への依頼の更新",
    description: "人間からの質問などを踏まえ、現在の実行に属する依頼の文脈や条件を更新する。版を進め、古い版への入力を識別する。",
    promptSnippet: "依頼の文脈を更新し、人間からの質問に補足する",
    parameters: Type.Object({
      requestId: Type.String(), expectedRevision: Type.Integer({ minimum: 1 }),
      prompt: Type.Optional(Type.String({ minLength: 1 })), context: Type.Optional(Type.Unknown()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = using(ctx, runtime => {
        assertBelongs(runtime.get(params.requestId), ctx);
        return runtime.amend(params.requestId, {
          expectedRevision: params.expectedRevision,
          ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
          ...(params.context === undefined ? {} : { context: params.context as JsonValue }),
        });
      });
      return { content: [{ type: "text", text: JSON.stringify(request) }], details: { requestId: request.id } };
    },
  });

  pi.registerCommand("human-pending", {
    description: "現在のセッション・分岐の依頼を確認する",
    async handler(_args, ctx) {
      const requests = using(ctx, runtime => runtime.list({ scope: scopeFor(ctx), limit: 1000 }).filter(request => belongs(request, ctx)));
      pi.sendMessage({ customType: "hith-inbox", content: JSON.stringify(requests, null, 2), display: true }, { triggerTurn: false });
    },
  });

  pi.registerCommand("human-respond", {
    description: "依頼ID 種類 版 JSON の形式で、人間の入力を保存する",
    async handler(args, ctx) {
      const match = /^(\S+)\s+(answer|question|progress|decline|failure)\s+(\d+)\s+([\s\S]+)$/.exec(args.trim());
      if (!match) throw new HarnessError("INVALID_ARGUMENT", '使い方: /human-respond 依頼ID answer 1 "回答" （種類: ' + inputKinds.join(", ") + "）");
      const [, id, kind, revision, payload] = match;
      const receipt = using(ctx, runtime => {
        const request = runtime.get(id!);
        assertBelongs(request, ctx);
        return runtime.respond(request.id, { inputId: randomUUID(), actor: request.recipient, kind: kind as InputKind, revision: Number(revision), payload: JSON.parse(payload!) });
      });
      ctx.ui.notify(`入力を保存しました: ${receipt.input.disposition}。/human-resumeでモデルに反映できます。`, "info");
    },
  });

  pi.registerCommand("human-resume", {
    description: "現在の分岐の新しい人間の入力を反映し、モデルを再開する",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const branch = ctx.sessionManager.getBranch();
      const delivered = new Set(branch.flatMap(entry => {
        if (entry.type !== "custom_message" || entry.customType !== messageType) return [];
        const details = entry.details as { sequence?: number; requestId?: string } | undefined;
        return typeof details?.sequence === "number" && typeof details.requestId === "string" ? [`${details.requestId}:${details.sequence}`] : [];
      }));
      const events = using(ctx, runtime => {
        const found: HumanEvent[] = [];
        let after = 0;
        for (;;) {
          const batch = runtime.events({ scope: scopeFor(ctx), after, limit: 1000 });
          for (const event of batch) {
            if (delivered.has(`${event.requestId}:${event.sequence}`) || !belongs(event.request, ctx)) continue;
            const current = runtime.get(event.requestId);
            if (event.type === "input.received" && event.input?.disposition === "accepted" && event.input.revision === current.revision) found.push(event);
            else if (event.type === "request.cancelled" || event.type === "request.expired") found.push(event);
          }
          if (batch.length < 1000) break;
          after = batch[batch.length - 1]!.sequence;
        }
        return found;
      });
      deliver(events, ctx);
    },
  });

  function deliver(events: HumanEvent[], ctx: ExtensionCommandContext): void {
    if (!events.length) { ctx.ui.notify("この分岐に新しい人間の入力はありません。", "info"); return; }
    events.forEach((event, index) => pi.sendMessage({
      customType: messageType,
      content: `人間への依頼に関するイベントです。用途上の意味は現在の作業に従って判断してください。\n${JSON.stringify(event)}`,
      display: true, details: { sequence: event.sequence, requestId: event.requestId },
    }, { triggerTurn: index === events.length - 1 }));
  }
}

export default function (pi: ExtensionAPI): void { registerHumanExtension(pi); }
