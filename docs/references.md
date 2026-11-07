# 参考文献と既存実装

確認日：2026年11月7日。以下は背景と比較対象です。今回の理論や実装の独自性は、今後検討します。

## 理論の背景

- Hollan, Hutchins, Kirsh（2000）[Distributed Cognition: Toward a New Foundation for Human-Computer Interaction Research](https://interactivity.ucsd.edu/articles/DCog/DCog.pdf)。人間と技術を含む環境全体の認知過程を扱う、今回の分析単位に近い研究です。
- Clark, Chalmers（1998）[The Extended Mind](https://www.consc.net/papers/extended.html)。外部の要素との結合が認知に果たす役割を検討する際の背景になります。
- Horvitz（1999）[Mixed-Initiative Interaction](https://www.microsoft.com/en-us/research/publication/mixed-initiative-interaction/)。人間とコンピュータが状況に応じて寄与する相互作用を扱います。

## 実装の参考

- pi [拡張の公式仕様](https://pi.dev/docs/latest/extensions)。独自ツール、コマンド、状態保存など、最初の実装先を検討するための資料です。
- pi [終了するツールの公式実装例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/structured-output.ts)。人間への依頼後にモデルの処理を止める方法の候補です。再開を含む適合性は別途検証します。
- LangGraph [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)。状態を保存して外部入力を待ち、後から処理を再開する既存の仕組みです。
- Pydantic AI [Deferred Tools](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)。承認や外部での結果生成を待つツールを扱います。
- Anthropic [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)。セッションをまたぐ作業における、ハーネスと状態の継続の設計例です。
- MCP [2026-07-28版の仕様](https://modelcontextprotocol.io/specification/2026-07-28)。確認時点の最新仕様です。
- MCP [Elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)。クライアントを介して人間へ入力を要求する仕様です。
- MCP [Tasks拡張](https://tasks.extensions.modelcontextprotocol.io/)。非同期の実行、途中の入力、結果の取得を扱う、今回の設計と重なる既存機構です。

## 今回検討する点

人間への質問、非同期の実行、待機・再開には既存の仕様と実装があります。今回の作業では、それらを使いながら、人間をハーネスに組み込む接続と実行基盤を構築します。分担や業務の手順は、その利用側に置きます。

既存機構との具体的な対応は[MCPとの比較](mcp.md)に記録します。既存の仕組みに対する利点や品質改善は、比較と測定の後で述べます。
