#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { HumanRuntime } from "./core/runtime.js";
import { HarnessError } from "./core/types.js";
import type { AmendRequest, InputKind, JsonValue, RequestStatus, RespondInput, SubmitRequest } from "./core/types.js";

const help = `Human-in-the-Harness — 人間への非同期な依頼と回答

使い方: hith <操作> [依頼ID] [オプション]

  submit --file 依頼.json               依頼を登録し、回答を待たずに返す
  list [--recipient 人間ID]             依頼一覧を表示する
  get <依頼ID>                         依頼の状態と結果を表示する
  respond <依頼ID> --revision 1 --text '回答' --actor human
  respond <依頼ID> --revision 1 --kind question --text '確認したいこと'
  respond <依頼ID> --file 入力.json     構造化した入力を記録する
  amend <依頼ID> --file 変更.json       文脈などを更新し、版を進める
  cancel <依頼ID>                      依頼を取り消す
  events [--after 0] [--request 依頼ID] イベントを再取得する

共通: --database パス（既定: HITH_DATABASE または ./var/hith.sqlite）
      --file - で標準入力からJSONを読む。結果はJSON、エラーは標準エラーに出力する。

submitの直接指定: --prompt '内容' --recipient human --requester agent --key 一意なキー
respond: --kind answer|question|progress|decline|failure
         --payload 'JSON' または --text '文字列'、--input-id 再送を識別するID
         --revision は、人間が確認した依頼の版を明示する。
list: --status pending|in_progress|completed|declined|cancelled|expired|failed
list / events: --scope 範囲 --limit 件数（既定100、上限1000）

このCLIはローカルの依頼ストアを操作する。役割の割り当てやモデルの起動は行わない。
`;

function readJson(path: string): unknown { return JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8")); }
function required(value: string | undefined, name: string): string {
  if (!value) throw new HarnessError("INVALID_ARGUMENT", `${name}が必要です。--helpで操作方法を確認できます。`);
  return value;
}

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, database: { type: "string" }, file: { type: "string" },
      prompt: { type: "string" }, recipient: { type: "string" }, requester: { type: "string" }, key: { type: "string" },
      actor: { type: "string" }, kind: { type: "string" }, revision: { type: "string" }, text: { type: "string" }, payload: { type: "string" },
      "input-id": { type: "string" }, scope: { type: "string" }, status: { type: "string" },
      after: { type: "string" }, request: { type: "string" }, limit: { type: "string" },
    },
  });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const [command, id] = positionals;
  if (positionals.length > 2) throw new HarnessError("INVALID_ARGUMENT", "位置引数が多すぎます。");
  const runtime = new HumanRuntime(resolve(values.database ?? process.env.HITH_DATABASE ?? "var/hith.sqlite"));
  try {
    let result: unknown;
    switch (command) {
      case "submit": {
        if (id) throw new HarnessError("INVALID_ARGUMENT", "submitの依頼内容は--fileまたは--promptで指定してください。");
        const input = values.file ? readJson(values.file) as SubmitRequest : {
          idempotencyKey: values.key ?? randomUUID(), requester: values.requester ?? "agent",
          recipient: values.recipient ?? "human", prompt: required(values.prompt, "--prompt"),
          ...(values.scope === undefined ? {} : { scope: values.scope }),
        };
        result = runtime.submit(input);
        break;
      }
      case "get": result = runtime.get(required(id, "依頼ID")); break;
      case "list": result = runtime.list({
        ...(values.recipient === undefined ? {} : { recipient: values.recipient }),
        ...(values.scope === undefined ? {} : { scope: values.scope }),
        ...(values.status === undefined ? {} : { status: values.status as RequestStatus }),
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      }); break;
      case "respond": {
        if (values.text !== undefined && values.payload !== undefined) throw new HarnessError("INVALID_ARGUMENT", "--textと--payloadは一方を指定してください。");
        const requestId = required(id, "依頼ID");
        let input: RespondInput;
        if (values.file) input = readJson(values.file) as RespondInput;
        else {
          const payload: JsonValue = values.payload !== undefined ? JSON.parse(values.payload) : required(values.text, "--textまたは--payload");
          input = {
            inputId: values["input-id"] ?? randomUUID(), actor: values.actor ?? "human",
            revision: Number(required(values.revision, "--revision")), kind: (values.kind ?? "answer") as InputKind, payload,
          };
        }
        result = runtime.respond(requestId, input);
        break;
      }
      case "amend": result = runtime.amend(required(id, "依頼ID"), readJson(required(values.file, "--file")) as AmendRequest); break;
      case "cancel": result = runtime.cancel(required(id, "依頼ID")); break;
      case "events": result = runtime.events({
        ...(values.after === undefined ? {} : { after: Number(values.after) }),
        ...(values.request === undefined ? {} : { requestId: values.request }),
        ...(values.scope === undefined ? {} : { scope: values.scope }),
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      }); break;
      default: throw new HarnessError("INVALID_ARGUMENT", `不明な操作です: ${command}`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { runtime.close(); }
}

try { main(); }
catch (error) {
  const code = error instanceof HarnessError ? error.code : "COMMAND_FAILED";
  process.stderr.write(`${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
}
