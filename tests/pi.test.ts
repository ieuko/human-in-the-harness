import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerHumanExtension } from "../src/adapters/pi.js";
import { HumanRuntime } from "../src/index.js";

test("実際のpi 1.5.0のローダーから拡張を読み込める", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hith-pi-loader-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/adapters/pi.js", import.meta.url))],
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  const extension = extensions.find(item => item.tools.has("human_submit"));
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()].sort(), ["human_amend", "human_cancel", "human_get", "human_submit"]);
  assert.ok(extension.commands.has("human-resume"));
  assert.equal(extension.tools.has("human_respond"), false);
});

test("人間の入力を同じpiの分岐に一度だけ渡し、別の分岐に混ぜない", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hith-pi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "store.sqlite");
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const branch: SessionEntry[] = [{ id: "origin", type: "custom", customType: "test", data: null, parentId: null, timestamp: new Date().toISOString() }];
  let modelRuns = 0;
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
    sendMessage: (message: { customType: string; content: string; display: boolean; details: unknown }, options: { triggerTurn?: boolean }) => {
      branch.push({ ...message, type: "custom_message", id: `message-${branch.length}`, parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
      if (options.triggerTurn) modelRuns++;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dir, sessionManager: { getSessionId: () => "session", getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch },
    waitForIdle: async () => {}, ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext & Parameters<ToolDefinition["execute"]>[4];
  registerHumanExtension(pi, { databasePath: database });
  const receipt = await tools.get("human_submit")!.execute("call-1", { prompt: "次に渡す文脈を考えてください" }, undefined, undefined, ctx);
  const requestId = (receipt.details as { requestId: string }).requestId;
  const runtime = new HumanRuntime(database);
  t.after(() => runtime.close());
  runtime.respond(requestId, { inputId: "human-answer", actor: "human", kind: "answer", revision: 1, payload: { nextContext: "過去の経緯を含める" } });
  const original = [...branch];
  branch.splice(0);
  await commands.get("human-resume")!.handler("", ctx);
  assert.equal(modelRuns, 0);
  await assert.rejects(() => tools.get("human_get")!.execute("call-2", { requestId }, undefined, undefined, ctx), /現在のセッション・分岐/);
  branch.push(...original);
  await commands.get("human-resume")!.handler("", ctx);
  assert.equal(modelRuns, 1);
  assert.equal(branch.filter(entry => entry.type === "custom_message" && entry.customType === "hith-event").length, 1);
  await commands.get("human-resume")!.handler("", ctx);
  assert.equal(modelRuns, 1);
});
