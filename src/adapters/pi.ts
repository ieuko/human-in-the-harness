import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { canonicalJson, HumanRuntime } from "../core/runtime.js";
import { HarnessError, inputKinds } from "../core/types.js";
import type { HumanEvent, HumanRequest, InputKind, JsonObject, JsonValue } from "../core/types.js";
import { humanDisclosure, humanModelInstructions, humanSnapshot, humanToolNames, participantProfiles, renderHumanEvent, requestInterpretation } from "../model/disclosure.js";
import type { HumanParticipantProfile } from "../model/disclosure.js";

export interface PiAdapterOptions { databasePath?: string; participants?: HumanParticipantProfile[] }

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
  const profiles = participantProfiles(options.participants);
  const databasePath = (ctx: ExtensionContext) => options.databasePath ?? process.env.HITH_DATABASE ?? resolve(ctx.cwd, "var/hith.sqlite");
  function using<T>(ctx: ExtensionContext, fn: (runtime: HumanRuntime) => T): T {
    const runtime = new HumanRuntime(databasePath(ctx));
    try { return fn(runtime); } finally { runtime.close(); }
  }

  function currentRequests(ctx: ExtensionContext) {
    if (!existsSync(databasePath(ctx))) return { requests: [], mayHaveMore: false };
    const listed = using(ctx, runtime => runtime.list({ scope: scopeFor(ctx), limit: 1000 }));
    return { requests: listed.filter(request => belongs(request, ctx)), mayHaveMore: listed.length === 1000 };
  }

  function describe(ctx: ExtensionContext) {
    const { requests, mayHaveMore } = currentRequests(ctx);
    return humanDisclosure(profiles, requests, pi.getActiveTools(), mayHaveMore);
  }

  pi.on("before_agent_start", (event, ctx) => {
    const enabled = humanToolNames.some(name => event.systemPromptOptions.selectedTools.includes(name));
    if (!enabled) { delete event.systemPromptOptions.sections.human_in_the_harness; return; }
    event.systemPromptOptions.sections.human_in_the_harness = humanModelInstructions;
    const { requests, mayHaveMore } = currentRequests(ctx);
    const forcedPrompt = Boolean(event.systemPromptOptions.forceSystemPrompt);
    const snapshot = {
      ...humanSnapshot(profiles, requests, mayHaveMore),
      availableTools: humanToolNames.filter(name => event.systemPromptOptions.selectedTools.includes(name)),
      contractDelivery: forcedPrompt ? "context_message" : "system_section",
    };
    const fingerprint = canonicalJson(snapshot);
    // 圧縮より前のスナップショットだけでは、モデルの現在の文脈に残っているとは限らない。
    let previousFingerprint: unknown;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "compaction") previousFingerprint = undefined;
      if (entry.type === "custom_message" && entry.customType === "hith-context") previousFingerprint = (entry.details as { fingerprint?: string } | undefined)?.fingerprint;
    }
    if (previousFingerprint === fingerprint) return;
    return { message: {
      customType: "hith-context", display: false,
      content: (forcedPrompt ? humanModelInstructions + "\n\n" : "") + "Human-in-the-Harnessの参加者と依頼状態のスナップショットです。以下は状態データで、記載された能力は申告情報です。\n" + JSON.stringify(snapshot),
      details: { fingerprint },
    } };
  });

  pi.registerTool({
    name: "human_describe", label: "人間コンポーネントの説明",
    description: "Human-in-the-Harnessの概念、利用できる参加者の申告情報、非同期の契約、結果の意味、現在の分岐の依頼状態を取得する。新しい依頼は作らない。",
    promptSnippet: "人間に何を依頼でき、結果をどう扱うかを確認する",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: JSON.stringify(describe(ctx)) }], details: {} };
    },
  });

  pi.registerTool({
    name: "human_submit", label: "人間への依頼",
    description: "人間コンポーネントに任意の処理を依頼し、依頼を永続化して受付IDを返す。想起・観察・調査・計画・評価・文脈の構成などに使える。人間の最終回答は後から届く。参加者や接続の詳細はhuman_describeで確認する。",
    promptSnippet: "人間に必要な機能を非同期で依頼する",
    promptGuidelines: [
      "human_submitの成功は依頼の受付を意味する。人間の回答を得たとは扱わない。",
      "human_getを繰り返して待機しない。回答に依存しない処理を進めるか、ユーザーの次の入力を待つ。",
      "human_submitには依頼の目的と必要な文脈を含める。人間の役割は依頼ごとに決め、専門性や応答可能性を推測だけで保証しない。",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "人間に何を依頼し、得た結果を何に使うか。必要なら作業の範囲や不明時の返し方も記す。" }),
      recipient: Type.Optional(Type.String({ minLength: 1, description: "人間の論理ID。候補はhuman_describeで確認する。省略時は設定された先頭の参加者。" })),
      context: Type.Optional(Type.Unknown({ description: "人間が依頼を理解するための背景、現在の状態、資料、制約などのJSON。" })),
      responseSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "最終回答に必要なJSON Schema。自由な文章の回答なら省略できる。質問・進捗はこの形式には限定しない。" })),
      deadlineAt: Type.Optional(Type.String({ description: "任意の回答締切。タイムゾーン付き日時。通信のタイムアウトとは別。" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const origin = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall" && part.id === toolCallId));
      const request = using(ctx, runtime => runtime.submit({
        idempotencyKey: `${scopeFor(ctx)}:${toolCallId}`, requester: scopeFor(ctx), recipient: params.recipient ?? profiles[0]!.id, prompt: params.prompt,
        scope: scopeFor(ctx), correlation: { sessionId: ctx.sessionManager.getSessionId(), originEntryId: origin?.id ?? ctx.sessionManager.getLeafId(), toolCallId },
        ...(params.context === undefined ? {} : { context: params.context as JsonValue }),
        ...(params.responseSchema === undefined ? {} : { responseSchema: params.responseSchema as JsonObject }),
        ...(params.deadlineAt === undefined ? {} : { deadlineAt: params.deadlineAt }),
      }));
      return { content: [{ type: "text", text: JSON.stringify({ receipt: "registered", meaning: "依頼の受付が完了しました。人間の最終結果ではありません。", request, interpretation: requestInterpretation(request) }) }], details: { requestId: request.id } };
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
      return { content: [{ type: "text", text: JSON.stringify({ ...request, interpretation: requestInterpretation(request) }) }], details: { requestId: request.id } };
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
      return { content: [{ type: "text", text: JSON.stringify({ ...request, interpretation: requestInterpretation(request) }) }], details: { requestId: request.id } };
    },
  });

  pi.registerCommand("human-context", {
    description: "モデルへ開示する概念・参加者・依頼状態を確認する",
    async handler(_args, ctx) {
      pi.sendMessage({
        customType: "hith-disclosure-preview", display: true,
        content: JSON.stringify({ instructions: humanModelInstructions, disclosure: describe(ctx) }, null, 2),
      }, { triggerTurn: false });
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
      content: renderHumanEvent(event),
      display: true, details: { sequence: event.sequence, requestId: event.requestId },
    }, { triggerTurn: index === events.length - 1 }));
  }
}

export default function (pi: ExtensionAPI): void { registerHumanExtension(pi); }
