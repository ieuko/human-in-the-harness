import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerHumanExtension } from "../src/adapters/pi.js";
import { HumanRuntime } from "../src/index.js";
import { humanModelInstructions, humanToolNames, participantProfiles } from "../src/model/disclosure.js";

test("実際のpi実行経路で、概念説明と状態データを分けてモデルへ渡す", { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "hith-model-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "requests.sqlite");
  const sessionManager = SessionManager.inMemory(dir);
  const origin = sessionManager.appendCustomEntry("test-origin", {});
  const runtime = new HumanRuntime(database);
  t.after(() => runtime.close());
  const request = runtime.submit({
    idempotencyKey: "active", requester: "test", recipient: "organizer", prompt: "依頼本文だけに置く識別文字列",
    scope: `pi:${sessionManager.getSessionId()}`, correlation: { originEntryId: origin },
  });
  runtime.submit({
    idempotencyKey: "other-session", requester: "test", recipient: "organizer", prompt: "別セッションの秘密",
    scope: "pi:other", correlation: { originEntryId: origin },
  });
  runtime.submit({
    idempotencyKey: "other-branch", requester: "test", recipient: "organizer", prompt: "別分岐の秘密",
    scope: `pi:${sessionManager.getSessionId()}`, correlation: { originEntryId: "not-in-this-branch" },
  });
  const profiles = [{ id: "organizer", description: "参加者説明だけに置く識別文字列", capabilities: ["過去の開催経緯を知っている可能性がある"] }];
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => registerHumanExtension(pi, { databasePath: database, participants: profiles })],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "hith-context-test", tokensPerSecond: 1_000_000 });
  modelRuntime.registerNativeProvider(faux.provider);
  const captured: { system: string; transcript: string }[] = [];
  faux.setResponses([1, 2, 3].map(() => (context: TranscriptContext) => {
    captured.push({ system: getCurrentSystemPrompt(context.messages), transcript: JSON.stringify(context.messages) });
    return fauxAssistantMessage("確認しました。");
  }));
  const { session } = await createAgentSession({
    cwd: dir, agentDir: join(dir, "agent"), modelRuntime, model: faux.getModel(),
    sessionManager, settingsManager: settings, resourceLoader: loader, tools: [...humanToolNames],
  });
  t.after(() => session.dispose());
  await session.prompt("利用できる接続を確認してください。");
  assert.equal(captured.length, 1);
  assert.ok(captured[0]!.system.includes(humanModelInstructions));
  assert.ok(!captured[0]!.system.includes("依頼本文だけに置く識別文字列"));
  assert.ok(!captured[0]!.system.includes("参加者説明だけに置く識別文字列"));
  assert.ok(captured[0]!.transcript.includes("依頼本文だけに置く識別文字列"));
  assert.ok(captured[0]!.transcript.includes("参加者説明だけに置く識別文字列"));
  assert.ok(!captured[0]!.transcript.includes("別セッションの秘密"));
  assert.ok(!captured[0]!.transcript.includes("別分岐の秘密"));
  await session.prompt("もう一度確認してください。");
  assert.equal(sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "hith-context").length, 1);
  runtime.respond(request.id, { inputId: "answer", actor: "organizer", kind: "answer", revision: 1, payload: "人間からの実際の入力" });
  const settled = new Promise<void>(resolve => {
    const unsubscribe = session.subscribe(event => {
      if (event.type === "agent_settled") { unsubscribe(); resolve(); }
    });
    t.after(unsubscribe);
  });
  await session.prompt("/human-resume");
  await settled;
  assert.equal(captured.length, 3);
  assert.ok(captured[2]!.system.includes(humanModelInstructions));
  assert.ok(captured[2]!.transcript.includes("human_input"));
  assert.ok(captured[2]!.transcript.includes("人間からの実際の入力"));
  assert.equal(sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "hith-context").length, 2);
});

test("状態が同じなら再注入せず、圧縮後には復元し、強制プロンプトは書き換えない", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hith-context-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "not-created.sqlite");
  let start!: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | void;
  const pi = {
    on: (name: string, handler: typeof start) => { if (name === "before_agent_start") start = handler; return () => {}; },
    registerTool: () => {}, registerCommand: () => {},
  } as unknown as ExtensionAPI;
  registerHumanExtension(pi, { databasePath: database });
  const branch: SessionEntry[] = [];
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test", getBranch: () => branch } } as unknown as ExtensionContext;
  const event: BeforeAgentStartEvent = {
    type: "before_agent_start", messageType: "user", prompt: "test", systemPrompt: "元のプロンプト",
    systemPromptOptions: {
      cwd: dir, selectedTools: [...humanToolNames], hiddenTools: [], toolSnippets: {}, toolGuidelines: {},
      promptGuidelines: [], sections: { existing: "残すセクション" }, appendSystemPrompt: "", contextFiles: [], skills: [],
    },
  };
  const first = start(event, ctx)!;
  assert.equal(event.systemPromptOptions.sections.existing, "残すセクション");
  assert.equal(event.systemPromptOptions.sections.human_in_the_harness, humanModelInstructions);
  assert.equal(existsSync(database), false);
  branch.push({ ...first.message!, type: "custom_message", id: "snapshot", parentId: null, timestamp: new Date().toISOString(), display: false });
  assert.equal(start(event, ctx), undefined);
  branch.push({ type: "compaction", id: "compacted", parentId: "snapshot", timestamp: new Date().toISOString(), summary: "圧縮済み", firstKeptEntryId: "snapshot", tokensBefore: 1 });
  assert.ok(start(event, ctx)?.message);
  event.systemPromptOptions.forceSystemPrompt = "指定された完全なプロンプト";
  const forced = start(event, ctx)!;
  assert.equal(event.systemPromptOptions.forceSystemPrompt, "指定された完全なプロンプト");
  assert.ok(String(forced.message!.content).includes(humanModelInstructions));
  event.systemPromptOptions.selectedTools = [];
  assert.equal(start(event, ctx), undefined);
  assert.equal(event.systemPromptOptions.sections.human_in_the_harness, undefined);
});

test("参加者の申告情報を検査し、固定の専門性や応答可能性を作らない", () => {
  const profiles = participantProfiles();
  assert.equal(profiles[0]!.id, "human");
  assert.equal(profiles[0]!.capabilities, undefined);
  assert.throws(() => participantProfiles([{ id: "same", description: "一人目" }, { id: "same", description: "二人目" }]), /重複/);
});
