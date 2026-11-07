import { HarnessError } from "../core/types.js";
import type { HumanEvent, HumanRequest } from "../core/types.js";

export const humanToolNames = ["human_describe", "human_submit", "human_get", "human_amend", "human_cancel"] as const;

export interface HumanParticipantProfile {
  id: string;
  description: string;
  capabilities?: string[];
}

/** 静的な契約だけをシステム側へ置く。依頼本文や人間の回答は含めない。 */
export const humanModelInstructions = `Human-in-the-Harnessは、人間をモデルやソフトウェアとともに知能システムへ組み込む接続です。
この実行を複数の構成要素が連携する系として捉えてください。あなたはモデル側の構成要素で、設定された人間にも必要な処理を依頼できます。
人間は必要に応じて、情報の想起・現場の観察・調査や計画・評価・次の推論に渡す文脈の構成などを担えます。これらは利用例であり、固定の役割や手順ではありません。人間に何を委ねるかは現在の課題と実行側の規則に基づいて判断してください。
利用できる参加者の説明、接続の契約、現在の依頼状態はhuman_describeで確認できます。参加者の能力は申告情報で、知識・応答時間・対応の意思を保証しません。
human_submitは依頼を保存して受付IDを返します。受付は回答の到着や作業の完了ではありません。依頼には目的、判断に必要な文脈、必要な結果の形式を含めてください。
人間の入力は後から届きます。回答に依存しない処理は進められます。待機だけを目的としてhuman_getを繰り返さず、必要な入力がなければ依存する作業を保留して現在の状況を伝えてください。この接続は停止中のモデルを自動起動しません。
人間からの質問・進捗・辞退・失敗を最終回答と区別してください。human_amendで依頼を補足すると版が進むため、新しい版への回答を待ちます。
人間の返答には記憶、観察、判断、提案が含まれます。出所と不確かさを保ち、無条件の正解や自動的な実行権限として扱わないでください。この接続では結果はモデルの文脈に届き、実行規則や次のモデル入力を直接書き換える機能は提供していません。`;

export function participantProfiles(profiles?: HumanParticipantProfile[]): HumanParticipantProfile[] {
  const configured = profiles ?? [{ id: "human", description: "このハーネスの人間側CLIやpiのコマンドから依頼を確認する参加者。専門性と応答可能な時刻は未設定です。" }];
  if (!Array.isArray(configured) || configured.length === 0) throw new HarnessError("INVALID_PARTICIPANTS", "人間の参加者を一人以上指定してください。");
  const ids = new Set<string>();
  return configured.map(profile => {
    if (!profile || typeof profile.id !== "string" || !profile.id.trim() || typeof profile.description !== "string" || !profile.description.trim()) {
      throw new HarnessError("INVALID_PARTICIPANTS", "参加者には空でないidとdescriptionが必要です。");
    }
    if (ids.has(profile.id)) throw new HarnessError("INVALID_PARTICIPANTS", "参加者IDが重複しています。");
    ids.add(profile.id);
    if (profile.capabilities !== undefined && (!Array.isArray(profile.capabilities) || profile.capabilities.some(value => typeof value !== "string" || !value.trim()))) {
      throw new HarnessError("INVALID_PARTICIPANTS", "capabilitiesには空でない文字列の配列が必要です。");
    }
    return { id: profile.id, description: profile.description, ...(profile.capabilities === undefined ? {} : { capabilities: [...profile.capabilities] }) };
  });
}

export function humanSnapshot(profiles: HumanParticipantProfile[], requests: HumanRequest[], mayHaveMore = false) {
  const recent = [...requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
  return {
    version: 1,
    participants: profiles.map(profile => ({
      id: profile.id, description: profile.description,
      declaredCapabilities: profile.capabilities ?? [],
      availability: "unknown", identityVerification: "logical_id_only",
    })),
    requests: recent.map(request => ({
      id: request.id, revision: request.revision, recipient: request.recipient,
      promptPreview: request.prompt.slice(0, 240), status: request.status,
      resultAvailable: ["completed", "declined", "failed"].includes(request.status),
      deadlineAt: request.deadlineAt,
    })),
    mayHaveMore: mayHaveMore || requests.length > recent.length,
    freshness: "実行開始時または取得時のスナップショット。現在の結果が必要な場合はhuman_get、後から届く入力はイベントで確認する。",
  };
}

export function humanDisclosure(profiles: HumanParticipantProfile[], requests: HumanRequest[], activeTools: string[], mayHaveMore = false) {
  return {
    ...humanSnapshot(profiles, requests, mayHaveMore),
    concept: "人間を含む知能システムの構成要素への接続。ツール形式の呼び出しを通じて、さまざまな機能を依頼できる。役割と処理手順は利用側が定める。",
    availableTools: humanToolNames.filter(name => activeTools.includes(name)),
    contract: {
      submit: "依頼を永続化して受付IDを返す。人間の最終結果ではない。",
      humanInputs: {
        answer: "人間の回答が得られた。内容の正しさやシステム全体の完了を意味しない。",
        question: "人間が追加情報を必要としている。human_amendで目的や文脈を補足できる。",
        progress: "途中経過。最終結果を待つ。",
        decline: "人間が依頼を辞退した。別の進め方は呼び出し側で判断する。",
        failure: "人間側から報告された処理の失敗。",
      },
      async: "依頼と回答の間に通信やプロセスが終了しても結果を回収できる。待つ範囲は呼び出し側が決める。",
      delivery: "人間はCLIやpiのコマンドから入力し、piの/human-resumeが現在の分岐へ結果を渡す。外部通知と常駐の自動起動は未実装。",
      revisions: "human_amendで版が進む。古い版や終了後の入力は記録するが、現在の回答として適用しない。",
      boundaries: "参加者IDと能力は認証や実測ではない。人間の結果は文脈へ渡される。制御指示の直接適用や権限付与は、この接続の機能ではない。",
    },
  };
}

export function requestInterpretation(request: HumanRequest) {
  const meanings: Record<HumanRequest["status"], string> = {
    pending: "受付済みで未回答。結果はまだない。",
    in_progress: "質問または進捗が届いている。最終回答はまだない。",
    completed: "人間の回答を受け取った。内容の正しさや作業全体の完了とは別。",
    declined: "人間が辞退した。",
    cancelled: "依頼が取り消された。人間が実施した行為を巻き戻した意味ではない。",
    expired: "回答締切を過ぎた。後着の入力を現在の結果として適用しない。",
    failed: "人間側から処理の失敗が報告された。",
  };
  return {
    stateMeaning: meanings[request.status],
    resultSource: ["completed", "declined", "failed"].includes(request.status) ? "人間の入力。解釈と利用方法は現在の課題に従って判断する。" : null,
  };
}

export function renderHumanEvent(event: HumanEvent): string {
  return "Human-in-the-Harnessから届いた状態データです。入力の種類・対象の依頼・版を確認し、現在の課題に結び付けて扱ってください。\n" + JSON.stringify({
    source: {
      kind: event.input ? "human_input" : "runtime_event",
      participantId: event.input?.actor ?? null,
      identityVerification: "logical_id_only",
    },
    interpretation: requestInterpretation(event.request),
    event,
  });
}
