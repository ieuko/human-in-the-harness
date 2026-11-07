# Human-in-the-Harness

人間を、モデルや他の構成要素とともに知能システムへ組み込むための理論と実装です。仮称を **Human-in-the-Harness**、リポジトリ名を `human-in-the-harness` としています。

人間への依頼を保存し、回答を待たずに受付IDを返します。人間が後から回答・質問・辞退しても、元の依頼に結び付けてハーネスへ戻せます。人間とモデルの分担、処理順序、何を待つかは利用側が決めます。

## 初版でできること

- SQLiteによる依頼・入力・イベントの永続化と、プロセス終了後の回収。
- 複数の未解決の依頼、途中の質問・進捗、回答・辞退・失敗の記録。
- 依頼と入力の再送の識別、任意のJSON Schemaによる回答の検査。
- 文脈の更新と版の管理、古い版への回答や取り消し・締切後の入力の識別。
- 人間側のCLIと、pi向けの依頼登録・状態取得・取り消し・結果反映。

MCP接続、自動通知、自動でモデルを起動する常駐処理はまだ実装していません。実モデルによる文章生成の品質も未評価です。役割を固定しない接続とライフサイクルを、初版の対象にしています。

## 始める

Node.js 24.14以上を使用します。

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

依頼を登録します。回答を待たずに、依頼IDと現在の状態を含むJSONが返ります。

```sh
node dist/src/cli.js submit --prompt '次の処理に必要な文脈を教えてください。' --key example-1
```

人間が、表示された依頼IDと確認した版を指定して回答します。別のターミナルからでも、同じデータベースを指定すれば操作できます。

```sh
node dist/src/cli.js respond '表示された依頼ID' --revision 1 --text '前回の決定理由も次の入力に含めてください。' --input-id example-answer-1
node dist/src/cli.js get '表示された依頼ID'
node dist/src/cli.js events --after 0
```

既定の保存先は作業フォルダの `var/hith.sqlite` です。`--database`または環境変数`HITH_DATABASE`で変更できます。同じ受付キーを同じ依頼者から再送すると、元の依頼が返ります。別の依頼には別のキーを使います。

## piで使う

ビルド後、piに拡張を読み込ませます。pi 1.5.0でローダーとの適合を確認しています。

```sh
npx --no-install pi -e ./dist/src/adapters/pi.js
```

モデルには`human_submit`、`human_get`、`human_amend`、`human_cancel`が追加されます。人間の回答を作る操作は、モデル向けのツールとして登録していません。

人間は`/human-pending`で依頼を見て、`/human-respond 依頼ID answer 1 "回答"`で入力し、`/human-resume`で現在の分岐の新しい入力を反映します。CLIから回答し、piへ戻って`/human-resume`を実行することもできます。

[piへの接続と操作方法](docs/pi.md)に、分岐との対応や再開の挙動を記載しています。

## ライブラリとして使う

```ts
import { HumanRuntime } from "./dist/src/index.js";

const humans = new HumanRuntime("var/hith.sqlite");
try {
  const request = humans.submit({
    idempotencyKey: "run-1:step-1",
    requester: "my-harness",
    recipient: "human",
    prompt: "この処理に必要な情報を補ってください。",
    correlation: { runId: "run-1" },
  });
  console.log(request.id);
  // 結果の使い方や、どの処理を待つかは呼び出し側で決める。
} finally {
  humans.close();
}
```

## 理論と実装の位置づけ

人間が担う機能と、人間をどう接続するかを分けて考えます。ツール形式で接続した人間が、調査を担うことも、サブエージェントとして計画することも、コンテキスト管理などのハーネス機能を担うこともできます。

Human-in-the-Harnessは、こうした構成を検討するための仮称です。全ての人間がハーネスそのものになるという定義は置きません。人間がハーネス機能を担う **Human as Harness** は、この基盤を使う構成の一つです。

- [理論のたたき台](docs/theory.md)
- [共通機構の設計と実装範囲](docs/design.md)
- [CLIとデータの仕様](docs/runtime.md)
- [MCPなどの既存機構との関係](docs/mcp.md)
- [企画書作成という利用例](examples/proposal/README.md)
- [参考文献と既存実装](docs/references.md)

## 検証と現在の範囲

```sh
npm run check
npm test
```

テストでは、別プロセスでの往復、競合する回答、再送、締切、版の更新、piのローダー、分岐ごとの結果反映を確認します。実モデルのAPIはテストから呼びません。

この版は、同じOSユーザーが操作するローカル環境を対象とします。参加者IDは論理的な識別子で、本人認証ではありません。締切はデータへのアクセス時に確認します。保存期間による自動削除や、停止中のハーネスの自動起動は行いません。

コードと理論は初版の研究・試作段階です。理論の独自性や課題の品質改善は未検証です。ライセンスはまだ設定しておらず、npmにも公開していません。
