import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHumanExtension } from "../../dist/src/adapters/pi.js";

// 架空の設定例。実際に依頼を受ける人間に合わせて説明を変更する。
export default function (pi: ExtensionAPI): void {
  registerHumanExtension(pi, {
    participants: [{
      id: "human",
      description: "このプロジェクトの進行に参加する人間。知っている範囲で背景の説明や検討に協力する。",
      capabilities: [
        "過去の決定経緯の想起",
        "成果物への意見や評価",
        "次の推論に渡す文脈の検討",
      ],
    }],
  });
}
