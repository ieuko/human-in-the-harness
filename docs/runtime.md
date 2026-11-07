# 実行基盤とCLIの仕様

初版はTypeScript、Node.jsのSQLite API、AjvによるJSON Schemaの検査で実装しています。外部のモデルや通信接続を必要とせず、ローカルで依頼と入力を保存できます。

## 依頼の登録

`HumanRuntime.submit()`は、依頼を永続化した後に返ります。人間の回答は待ちません。受付の成功と、人間の作業の完了を区別します。

```json
{
  "idempotencyKey": "run-1:step-1",
  "requester": "my-harness",
  "recipient": "human",
  "prompt": "この作業に必要な情報を補ってください。",
  "context": { "目的": "次の検討へ進むため" },
  "responseSchema": { "type": "string" },
  "scope": "run-1",
  "correlation": { "runId": "run-1", "stepId": "step-1" },
  "deadlineAt": null
}
```

必須なのは`idempotencyKey`、`requester`、`recipient`、`prompt`です。同じ依頼者と受付キーには同じ依頼IDを返します。内容が異なる場合は`IDEMPOTENCY_CONFLICT`になります。

`context`は任意のJSONです。`responseSchema`はJSON Schema 2020-12のオブジェクトを候補とし、登録時にコンパイルします。ネットワーク経由の参照解決や追加のformat定義は行いません。

`deadlineAt`にはタイムゾーン付き日時または`null`を指定します。省略時は締切を設けません。`scope`と`correlation`は、利用側の実行との対応に使う任意の情報です。

## 人間からの入力

```json
{
  "inputId": "response-1",
  "actor": "human",
  "kind": "answer",
  "revision": 1,
  "payload": "前回の決定理由も考慮してください。"
}
```

`inputId`は入力の再送を識別します。同じID・内容の再送は新しいイベントを作りません。同じIDに違う内容を指定するとエラーになります。`actor`は依頼の`recipient`と一致する必要がありますが、本人認証を実現する値ではありません。

| kind | 作用 |
|---|---|
| `answer` | 回答スキーマを検査し、`completed`にする |
| `question` | 質問を記録し、`in_progress`にする |
| `progress` | 進捗を記録し、`in_progress`にする |
| `decline` | 辞退を記録し、`declined`にする |
| `failure` | 人間側から報告された失敗を記録し、`failed`にする |

質問や進捗は、最終回答のスキーマでは検査しません。「わからない」は、呼び出し側が設計した回答の一つとして表現できます。

返される`disposition`は`accepted`（現在の依頼に反映）、`stale`（版が古い）、`late`（既に終了した依頼への入力）のいずれかです。後二者も履歴に残しますが、依頼の状態や結果を変更しません。

`completed`は結果を受け取ったという意味です。業務上の承認や、システム全体の完成を意味しません。`false`や`null`も、スキーマで許されていれば回答にできます。

## 変更・取り消し・締切

```json
{
  "expectedRevision": 1,
  "context": { "追加条件": "前回の決定理由を優先する" }
}
```

`amend()`は、指定した版が最新であることを確認し、文脈・本文・回答形式・締切を更新して版を進めます。終了した依頼は変更できません。再送時の版の不一致は、最新の依頼を取得して照合します。

`cancel()`は未解決の依頼を取り消します。既に結果がある場合はその状態を返します。人間が実施した現実の行為は巻き戻しません。

締切の確認は`get()`、`list()`、`events()`などでアクセスした際に行います。常駐タイマーはありません。締切後の入力は`late`となり、`expired`の依頼を再開させません。保存期間による削除は未実装です。

## イベントの回収

`events({ after, requestId?, scope?, limit? })`で、保存された順序番号`sequence`に従ってイベントを取得します。最後に処理した番号を保存すれば、その後のイベントを再取得できます。通知の配信や、モデルの起動はこのAPIの責務に含めません。

イベントには、その時点の依頼のスナップショットと、該当する人間の入力を含みます。現在の状態が必要な場合は`get()`を使います。既定の取得件数は100、上限は1000です。イベントは最後の番号を`after`にして続きが取得できます。

## 保存と競合

依頼、入力、イベントを同じSQLiteデータベースに保存します。変更にはトランザクションを使い、別プロセスから最終回答が競合した場合も、一方だけが現在の依頼に適用されます。

外部ハーネスの履歴と、このデータベースを一括で更新する分散トランザクションはありません。呼び出し側は依頼IDとイベントIDを保持し、再試行や結果の再適用を扱う必要があります。

## CLI

```sh
node dist/src/cli.js submit --file examples/proposal/request.json
node dist/src/cli.js list --recipient human
node dist/src/cli.js get '依頼ID'
node dist/src/cli.js respond '依頼ID' --revision 1 --kind question --text '追加の条件はありますか？'
node dist/src/cli.js respond '依頼ID' --file examples/proposal/response.json
node dist/src/cli.js amend '依頼ID' --file '変更内容.json'
node dist/src/cli.js cancel '依頼ID'
node dist/src/cli.js events --after 0 --request '依頼ID'
```

`--database`で保存先を指定できます。全ての正常な結果はJSON、エラーは標準エラーへのJSONと終了コード1で返します。`--file -`は標準入力からJSONを読みます。詳しい引数は`--help`を参照してください。
