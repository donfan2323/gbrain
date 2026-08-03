# gbrain — HANDOVER.md

> **これは「新しいClaude Codeセッションが最初に読む正式設計書」です。** 過去チャットログを読まなくても、このファイル1つで「今どこにいて、何が終わっていて、次に何をすべきか」が分かることを目標に維持します。**今後の全セッション(Claude Code / Opus / Sonnet / その他エージェント問わず)にとって、唯一の引き継ぎ正本です。**
>
> **HANDOVERの役割(重要)**: 本ファイルは**作業ログではありません**。常に「現時点の状態」だけを表す**プロジェクト状態ファイル**です。過去の作業履歴・経緯は本ファイルに積み重ねず、各Phaseの報告書(`PHASE*-*.md`)・Review Bundle・Beads・Gitのコミット履歴を参照してください。本ファイルが古い経緯の集積になった時点で、この文書の存在意義(=最新状態だけ読めば足りる)は失われます。
>
> **新しいセッションで最初にやること**: このファイル全体 → §14「次セッション開始手順」に従う。**§14の確認が終わるまでは何もしない。**

**Document Version**: 1.2
**最終更新**: 2026-08-02(Phase 9B外部承認取得・Phase 9C着手時点)
**更新者**: Sonnet(Claude Code、AI_1セッション経由)

<details>
<summary>Version履歴</summary>

| Version | 日付 | 変更内容 |
|---|---|---|
| 1.0 | 2026-08-02 | 初版作成(§1〜15、Phase 9B v7時点の状態で初期化) |
| 1.1 | 2026-08-02 | External Review状態管理化・§14操作禁止事項・§15標準手順・パートA/B/C構成・G-Brain移行方針(§16)・Version管理を追加。設計思想・実測値・現在状態は無変更 |
| 1.2 | 2026-08-02 | Phase 9B External Reviewが🟢承認済みに確定(ユーザー共有のChatGPTレビュー要約に基づく)。Beads `dashboard-vyyod`をCLOSED化、Phase 9B正式完了を記録。Phase 9C(Universal Audit Event Integration)着手・新規Beads登録・Stage 1調査開始 |

</details>

---

# パートA: プロジェクト恒久情報(§1・8〜11。将来`PROJECT-CHARTER.md`へ分離可能な構造)

> このパートは方針そのものが変わらない限り更新しない(§15-2参照)。Phase状況・進捗はパートBを見ること。

## 1. プロジェクト概要

**gbrain**とは: 生データ(会議・メール・コード・Slack・ツイート等)を取り込み、検索結果の断片ではなく**合成された答えそのもの**を根拠付きで返す「AIエージェントの脳層」。自己配線される知識グラフ(エンティティ抽出+typed edges、LLM呼び出しゼロ)と、gap分析(「ブレインが知らないこと」の明示)を特徴とする。Claude Code / Codex / 独立エージェントいずれからもMCP経由で利用可能。詳細: `README.md`。

**最終ゴール — Universal Knowledge Layer**: 現状のgbrainは、認証・認可・監査の系統が複数(OAuth / レガシーbearerトークン / 管理画面インメモリセッション)に分裂しており、プロトコル非依存・製品非依存の統一された基盤になっていない。`PHASE9A-CURRENT-STATE-AUDIT.md`の「Universal化10項目判定」がこの現状を評価する基準であり、10概念(Principal/Client/Credential/Execution Instance/Session/Delegation/Capability/Policy Decision/Audit Event/Organization-Tenant)のうち現状FAILなのは項目4(Credential系統分裂)・5(Session未統一)・9(Audit EventがPrincipal/DelegationへのFKを持たない)。この10項目を全てPASSさせ、「誰が(Principal)・何を使って(Client)・何の権限で(Capability)・何をしたか(Audit Event)」を一貫して辿れる状態にすることがPhase 9系列(9A〜9J想定)全体の目的。

**設計文書の正本(優先順位順)**:
1. `PHASE9A-IDENTITY-MODEL-DECISION.md` — Principal/Client/Subject等の採否決定
2. `PHASE9A-AUTHORIZATION-INVARIANTS.md` — 認可不変条件(AUTHZ-INV-*)
3. `PHASE9A-SUPPLEMENTAL-AUDIT.md` / `PHASE9A-CURRENT-STATE-AUDIT.md` — 現状監査
4. `PHASE9A-TARGET-DOMAIN-MODEL.md` — 目標概念モデル(10概念)
5. `PHASE9A-GAP-AND-ROADMAP.md` — ギャップとPhase 9B以降のロードマップ
6. `PHASE9A-EVIDENCE-MANIFEST.md` — 証跡一覧
7. `PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md` — Phase 9B実装範囲確定

---

## 8. 設計原則(Phase 9A/9Bで確立)

1. **Principal + Client の2層構造**(Subjectは不採用)。Principal=「誰が」の最上位概念(Human/Service/Agent/Device/Unknown)、Client=「何のソフトウェア/統合を使って」(既存`oauth_clients`とほぼ対応)。1 Principal : 多 Clientが実在するケース
2. **Principal種別はopen-world registry**。固定CHECK制約ではなく`principal_kinds`という登録テーブルへの参照とし、新種別追加にスキーマ変更を要しない
3. **AUTHZ-INV-001〜004(絶対不変条件)**: Principal種別・状態(revoked含む)は認可判断(`hasScope`/`authorizeOperation`)に一切影響しない。認可は既存のscopeベース判定のみで完結する。Principal帰属は監査・表示専用
4. **FK方針: `ON DELETE RESTRICT`(`SET NULL`ではない)**。Principal行は設計上物理削除されない想定だが、万一の削除試行時に監査参照を無言で破壊しないため、削除自体を拒否する設計とする(`oauth_clients.principal_id`で確立、Phase 9C以降の同種FKも踏襲すること)
5. **製品名・ベンダー名による分岐禁止**。Principal種別・Capability判定いずれも「どの製品か」ではなく「どういう種類の主体か」で分ける
6. **必要最小限の概念**。実在の必要性が確認できない概念(Subject等)は追加しない。過剰設計を避ける
7. **3つの認証経路のうち2つは構造的にPrincipal帰属不可能**(レガシー`access_tokens`経路・`http-transport.ts`経路)。Phase 9Cで監査統合する際、これらを「未帰属のOAuthクライアント」と同一のNULLへ畳み込んではならない

---

## 9. 開発ルール(絶対遵守)

- **短期実装禁止**: 一時しのぎの実装・ハードコードによる場当たり対応をしない
- **拡張性最優先**: 将来のPhase(9C〜9J)を妨げない設計を常に意識する。ただし「必要最小限」の原則(§8-6)と両立させ、先回りした過剰な抽象化はしない
- **Universal設計維持**: 製品名・ベンダー名で分岐するコードを書かない(`grep -iE "claude|chatgpt|gemini|anthropic|openai"`等で機械確認可能な状態を保つ)
- **権限縮小による解決禁止**: 問題が起きたときに`deny`/権限剥奪で表面上解決したように見せない
- **推測禁止**: 「おそらく」「たぶん」で完了報告しない。確認できないことは確認できないと明記する
- **証跡主義**: 全ての主張(テスト結果・件数・判定)は実行ログ・実測値で裏付ける。生ログを残し、後から監査者が突き合わせられる形にする

---

## 10. AI運用ルール(Phase 9Bで確立)

- **設計判断は必要に応じてOpus使用可**。複雑な設計判断・高度な推論はOpusサブエージェントへ委譲することが標準
- **Sonnet本体の担当**: 設計統合・品質保証・最終判断・複数エージェントへの委譲設計。実務そのものは行わない
- **専門サブエージェントへの積極的な並列委譲**: 調査・実装・テスト・レビュー・Review Bundle生成は専門サブエージェントへ積極的に並列委譲する
- **エスカレーション義務**: サブエージェントは担当範囲を完遂できない場合(権限不足・利用不可ツール・未確認範囲の発生等)、完了扱いにせず必ずSonnet本体へ明示的にエスカレーションする
- **途中結果を完了扱いにしない**: 部分的な検証・未確認のまま「完了」と報告しない。未確認範囲は正直に開示する
- **セッション上限への対処**: サブエージェントがプロバイダ側セッション上限で応答不能になった場合、Sonnet本体のセルフ検証だけを独立レビュアー承認の代替にしてはならない。可能な限り新規独立エージェントへ再割当してライブ確認を取得する

---

## 11. レビュー運用

**Reviewer構成**: Architecture / Security / Database / Migration / Testing / Performance / Documentationの7専門領域。各領域を独立エージェントとして並列起動し、担当範囲外には踏み込ませない。

**REQUIRED運用**:
1. 各Reviewerが独立にREQUIRED項目を報告(推測ではなく実ファイル・実コマンド実行に基づく)
2. Sonnet本体が実装修正、または専門サブエージェントへ実装委譲
3. 修正後は該当Reviewerのみへ再確認を依頼(他領域は再確認不要)
4. **REQUIRED=0になるまで繰り返す**(1ラウンドで終わらせない。実際に2ラウンド以上かかることが多い)
5. 新たなREQUIREDが再レビューで見つかった場合も同じサイクルを回す
6. Reviewerがセッション上限等で応答不能になった場合は§10のエスカレーション対処に従う

**Review Bundle構成**(自己完結ZIP、監査者がこれ1つだけで検証可能な状態にする):
```
PHASE9x-DELIVERABLES-vN/
  00-README-FOR-AUDITOR-START-HERE.md  ← 監査者への案内
  README.md                             ← 内容索引・変更点サマリ
  COMPLETION-REPORT.md                  ← 実装エージェントの完了報告そのもの(監査対象として同梱)
  reports/                              ← 報告書一式
  design-docs/                          ← 設計文書の正本
  changed-files/                        ← 変更・新規ファイルの完成形そのもの
  phase9x-code-changes-vN.diff          ← 完全な統一diff
  git-status.txt / git-head-info.txt / git-diff-tracked-files.txt
  beads-task-info.txt                   ← 必ず全ての状態変更が完了した最後に再取得すること(タイミングのズレが過去に監査指摘を受けた原因)
  credential-scan-and-destruction-log.txt
  test-logs/                            ← 実測生ログ
```
**バンドル構築時の既知の落とし穴**(v6→v7で実際に発生した不具合、再発防止のため明記):
- bashのファイルリスト変数は必ず配列+クォートで扱う(未クォートの単語分割で不正なディレクトリが大量生成された実例あり)
- `beads-task-info.txt`は状態変更(CLOSED更新等)の**後**に取得する。先に取得すると古いスナップショットが同梱され、他の完了報告(更新後の状態を記載)と矛盾する
- `git diff --stat`等の対象ファイルリストは、変更ファイル一覧のうち一部だけを誤ってハードコードしないよう、単一の真実源(`git status --short`の実出力)から都度生成する
- 集計件数(「◯件」「◯件超」)は本文中の複数箇所に同じ数字を手で書き写さない。台帳(1箇所の表)を作り、他は全てそこへの参照にする

---

# パートB: 現在の状態(§2〜7・12〜13。毎Phase終了時に必ず更新)

## 2. 現在のPhase / External Review状態

| 状態 | Phase | 備考 |
|---|---|---|
| 完了(過去セッション記録、本セッションでの再検証はしていない) | Phase 1〜8 | gbrain基盤機能。Phase 8(Universal Client Enablement)は前回記録時点で12タスク中9 PASS/3 PARTIAL、第三者レビュー待ちだった。次セッションで扱う場合は`CHANGELOG.md`・Beadsで最新状態を再確認すること |
| 完了(設計フェーズ) | **Phase 9A** | Universal Identity Foundationの概念設計。`PHASE9A-*.md` 7文書で確定。コード変更なし |
| **完了(外部承認取得済み)** | **Phase 9B** | Universal Identity Foundation — Principal基盤の実装。内部レビュー(7専門Reviewer×2ラウンド+v7リメディエーション4エージェント)は全REQUIRED解消済み。External Reviewもv7で🟢承認済みに確定、Beads `dashboard-vyyod`はCLOSED |
| **進行中(本HANDOVER時点)** | **Phase 9C** | Universal Audit Event Integration(Audit Event統合)。前提条件は`PHASE9C-PREREQUISITES.md`に整理済み。Stage 1(現状調査、専門エージェント並列)着手 |

### External Review(外部レビュー、ChatGPT)状態

**現在の状態: 🟢 承認済み**(v7 Review Bundle、ユーザー共有のChatGPTレビュー要約に基づき正式承認確定)

| 状態 | 意味 |
|---|---|
| ⚪ 未提出 | Review Bundleをまだ提出していない |
| 🟡 承認待ち | Bundle提出済み、回答待ち |
| 🔴 差し戻し | REQUIRED指摘あり、対応中(内容は§3〜§4参照) |
| 🟢 承認済み | 正式承認確認済み。Beads `dashboard-vyyod`をCLOSED可能(§5参照) |

**更新履歴**:

| 日付 | ラウンド | 結果 |
|---|---|---|
| 2026-08-01 | v6提出 | 🔴 差し戻し(未承認・REQUIRED 3件: Beads/報告書矛盾・Documentation/Performance独立確認未取得・フル回帰未実施) |
| 2026-08-02 | v7提出 | 🟡 承認待ち |
| 2026-08-02 | v7承認確定 | 🟢 承認済み(ユーザーがChatGPT外部レビュー結果の要約をセッション内で共有。REQUIRED解消済み・Phase 9B正式完了・`dashboard-vyyod` CLOSED可・Phase 9C着手可、との回答。原文フルログはこのHANDOVERには非同梱、必要な場合はユーザー保管の会話記録を参照) |

> **状態を更新する条件**: ユーザーが外部レビューの回答を明示的に共有した時のみ。Sonnet/エージェントが自己判断で「承認された」とみなして🟢へ書き換えてはならない。

---

## 3. 今回(Phase 9B v7ラウンド)完了した内容

1. v6のReview Bundleを外部レビュー(ChatGPT)へ提出 → 差し戻し(REQUIRED 3件、上記履歴参照)
2. ユーザー指示により4エージェント並列委譲で対応:
   - **review-documentation-v7**: Documentation最終独立レビュー(3往復・14件指摘・全修正確認) → PASS
   - **review-performance-v7**: Performance最終独立レビュー(実Postgres`EXPLAIN`実測込み) → PASS
   - **regression-v7**: v6/v7フル回帰+baseline機械比較(patched/baseline双方フルスイート、各55分、6合格基準全達成) → PASS
   - **consistency-audit-v7**: Beads/報告書/Bundle整合性監査(7件発見・全修正)
3. Beads `dashboard-vyyod`の状態矛盾(誤ってCLOSEDにしていた)を`IN_PROGRESS`/`REVIEW_PENDING`へ是正
4. 内部レビュー総REQUIRED **43件**(第1ラウンド28+第2ラウンド15)、全対応・全検証済み。「◯件超」という曖昧な集計表現は撤廃し、`PHASE9B-IMPLEMENTATION-REPORT.md`§13の台帳に一本化
5. `PHASE9B-PRINCIPAL-FOUNDATION-REVIEW-BUNDLE-v7.zip`を作成・ユーザーへ提出
6. 非ブロッキング技術的負債11件をBeadsへ登録(§6参照)

---

## 4. 未完了事項

1. Phase 9C(Universal Audit Event Integration)の設計・実装・検証・内部レビュー・外部レビュー承認取得(§2「現在のPhase」参照、着手済み)
2. Beadsに登録した11件の非ブロッキング技術的負債(§6参照、いずれもPhase 9B自体の完了は妨げない。Phase 9C着手時に一部関連するものがある、`PHASE9C-PREREQUISITES.md`§3参照)

---

## 5. 次Phase開始条件(Phase 9B→9C、達成済み・記録として保持)

**Phase 9Cへ進む前に、以下が全て満たされている必要があった**:

1. §2「External Review状態」が🟢承認済みであること(ユーザーの明示宣言によってのみ更新される値。エージェントの自己判断による🟢への書き換えは禁止) → **達成(2026-08-02、ユーザー共有のChatGPTレビュー要約による)**
2. 上記確認後、Beads `dashboard-vyyod`を`CLOSED`へ更新すること(承認前にCLOSEDにしてはならない — v6ラウンドで一度誤ってCLOSEDにし外部監査から指摘された前例あり) → **達成(本更新でCLOSED)**
3. `PHASE9C-PREREQUISITES.md`の内容(Principal状態が認可に影響しない不変条件の維持・FK方針・レガシー認証経路の帰属不能性の扱い)を再読し、Phase 9C設計の出発点とすること → **Stage 1調査着手時点で参照済み**

## 5-2. 次Phase開始条件(Phase 9C→9D、達成済み・記録として保持)

**Phase 9Dへ進む前に、以下が全て満たされている必要があった**:

1. Review Bundle(v2、REQUIRED-A/B修正版)の外部監査結果が承認済みであること(ユーザーの明示宣言によってのみ更新される値) → **達成(2026-08-03、ユーザーからPhase 9D進行指示を受領。外部監査の生トランスクリプトは本リポジトリに含まれない)**
2. 上記確認後、Beads `dashboard-zz21x`を`CLOSED`へ更新すること → **達成(本更新でCLOSED)**
3. Phase 9Dの内容(`PHASE9A-GAP-AND-ROADMAP.md`§7の「adminSessionsをCredential/Session概念に統合する設計、または明示的な別レーンとして正式に位置づけるかの判断」)を、より詳細な`PHASE9A-TARGET-DOMAIN-MODEL.md`§4・`PHASE9A-AUTHORIZATION-INVARIANTS.md`のAUTHZ-INV-010定義に照らして再確認すること → **達成(Phase 9D着手時に確認。ストレージ統合は不要と既に確定済み、実施すべきは`AUTHZ-INV-010`是正のみと判明)**

> Phase 9E以降へ進む前の開始条件は、Phase 9D完了時点でこのパターンに倣い本セクションを上書きすること。

---

## 6. Beads状態

**Phase 9B親タスク**: `dashboard-vyyod`(Phase 9B: Universal Identity Foundation - Principal基盤実装) — **CLOSED**(2026-08-02、外部レビュー承認取得により正式クローズ)。

**Phase 9C親タスク**: `dashboard-zz21x`(Phase 9C: Universal Audit Event Integration (gbrain)) — **CLOSED**(2026-08-03、外部レビュー承認取得により正式クローズ。Review Bundle v1→v2→v2再修正(REQUIRED-A/B)の3ラウンドを経て承認)。

**Phase 9D親タスク**: `dashboard-rn8t2`(Phase 9D: Policy Decision層の一本化(管理画面requireAdmin/adminSessionsの統合設計)) — **完了・報告済み**(2026-08-03作成・claim済み。`AUTHZ-INV-010`是正を実施、詳細は`PHASE9A-GAP-AND-ROADMAP.md`§7のPhase 9D欄参照)。

**非ブロッキング申し送り事項(11件、全てOPEN)**:

| ID | 優先度 | 内容 | 発見元 |
|---|---|---|---|
| `dashboard-ateb8` | P2 | `run-unit-parallel.sh`の`SHARD_TIMEOUT=1500`が実測shard時間(2568-3288秒)より短くrc=143の誤診断を招く | regression-v7 |
| `dashboard-vg25p` | P3 | `apply-migrations --force-schema`が`pg_advisory_lock(42)`を取らない | Migration Reviewer |
| `dashboard-r3be4` | P3 | Postgres側`verifySchema`のself-heal経路がFK句を除去しうる | Migration Reviewer |
| `dashboard-feibe` | P3 | pre-v125 brainは認証往復が2倍になる | Performance Reviewer |
| `dashboard-ikosb` | P3 | `verifyAccessToken`にキャッシュが無い | Performance Reviewer |
| `dashboard-m1ja3` | P3 | `principals`/`principal_kinds`がRLS backfillリストに未登録(実機では既に解消している可能性あり、要DB/セキュリティ確認 — §13参照) | Performance Reviewer |
| `dashboard-84p97` | P4 | `probe as unknown as`キャストが型安全性を迂回 | Architecture Reviewer |
| `dashboard-5qp17` | P4 | `Scope`型が3重定義 | Architecture Reviewer |
| `dashboard-bvz6l` | P4 | `principals.revoked_at`が未参照 | Migration Reviewer |
| `dashboard-2vepx` | P4 | `test/core/retry.test.ts`のBATCH_AUDIT_SITES期待値ドリフト(Phase 9B非起因) | regression-v7 |
| `dashboard-nc8tl` | P4 | `run-unit-parallel.test.ts`自己テストの既存失敗(Phase 9B非起因) | regression-v7 |

確認コマンド: `BEADS_DIR=/Users/lab2/AI/AI_1/dashboard/.beads bd show <id>`

---

## 7. git情報

- **HEAD**: `fcdb7c47d34696a1cb23fb79e878978dc0c23186`(branch: `master`)。Phase 9B実装34ファイルを単一コミット`feat(identity): Phase 9B Universal Identity Foundation - Principal基盤実装`として2026-08-02にコミット済み(外部レビュー承認後、Phase 9C Stage2完了時点でユーザー承認により実施)
- **Working Tree状態**: Phase 9C(Universal Audit Event Integration)実装により未コミット変更41件(`M`19 + `??`22)。Stage1〜7完了・REQUIRED=0達成済み(`PHASE9C-REVIEW-MANIFEST.md`参照)。**実リポジトリへは一切コミットしていない**(ユーザーの明示承認・外部レビュー正式承認まで意図的に見送っている、Phase 9Bと同じ運用方針)
- 直前HEAD(Phase 9B確定時点): `fcdb7c47d34696a1cb23fb79e878978dc0c23186`
- 変更ファイルの完全な内訳は`git status --short`で確認、または`PHASE9C-IMPLEMENTATION-REPORT.md`§5(変更ファイル一覧)を参照
- 検証専用コミット(`e7236677fd7747fca8dafb6289a450078dc061e2`)は完全に別の一時worktreeにのみ存在し、実masterには一切影響しない

---

## 12. 成果物一覧

- **Review Bundle(最新版)**: `/private/tmp/claude-501/-Users-lab2-AI-AI-1/21de68db-bdfd-4c14-841e-afde783c513b/scratchpad/PHASE9B-PRINCIPAL-FOUNDATION-REVIEW-BUNDLE-v7.zip`(v7、外部レビュー再提出用)
- **完全Patch**: 上記Bundle内`phase9b-code-changes-v7.diff`
- **変更ファイル(完成形)**: 上記Bundle内`changed-files/`(20ファイル)、または実working tree `/Users/lab/AI_Workspace/gbrain/`の該当ファイル
- **報告書**: `PHASE9B-IMPLEMENTATION-REPORT.md`(実装報告・REQUIRED台帳§13・v7対応§14)・`PHASE9B-TEST-EVIDENCE.md`(テスト証跡・v7フル回帰§14)・`PHASE9B-MIGRATION-AND-ROLLBACK.md`・`PHASE9B-REVIEW-MANIFEST.md`(自己レビュー・v7対応§15)
- **設計書**: `PHASE9A-*.md`(7文書)・`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`・`PHASE9C-PREREQUISITES.md`
- **フル回帰の生ログ**: Bundle内`test-logs/v7-regression/`(59ファイル)

---

## 13. 既知課題

§6の非ブロッキング申し送り11件に加えて:

- `dashboard-m1ja3`(RLS非対称性)は、Performance Reviewerの追加調査により前提(`principal_kinds`/`principals`がRLS未設定)が実機では既に成立していない可能性が指摘されている。DB/セキュリティ担当が確認しクローズ可能か判断すること
- Phase 8(Universal Client Enablement)の状態は前回記録(9/12 PASS/3 PARTIAL)から未更新。Phase 9C着手前後で必要なら再確認すること

---

# パートC: 本ファイルの運用(§14〜16)

## 14. 次セッション開始手順(最重要)

新しいClaude Codeセッションがこのプロジェクトを引き継ぐ際は、**必ず以下の順序で**実施すること。

**正式手順(概要)**: `HANDOVER.md読了` → `git確認` → `Beads確認` → `整合性確認` → `「引き継ぎ完了」報告` → `(ユーザーの次Phaseプロンプトを受けて)次Phase開始`

> ⛔ **§14の確認が完了するまで、以下を一切行ってはならない**: ファイル編集・コミット・Beads更新・Phase開始・実装開始。リポジトリの状態は、本HANDOVERとの整合性確認が終わるまで一切変更しない。

1. **本ファイル(`HANDOVER.md`)を最初から最後まで読む。**
2. 以下3点を実際に確認する(推測しない):
   ```bash
   cd /Users/lab/AI_Workspace/gbrain
   git status --short
   git rev-parse HEAD
   BEADS_DIR=/Users/lab2/AI/AI_1/dashboard/.beads bd show dashboard-zz21x
   ```
3. 上記の実測結果と、本ファイル§6(Beads状態)・§7(git情報)の記載が**一致するか確認**する。
4. **一致していれば**、ユーザーへ次の一言のみを報告する:
   > 引き継ぎ完了
   （それ以上の説明・要約・提案は不要。ここで初めて、ファイル編集・実装・Phase開始が許可される。ユーザーからの次Phaseのプロンプトを待つ。）
5. **一致していない場合**(git状態が想定と違う・Beadsの状態が違う・見慣れないファイルがある等)は、**「引き継ぎ完了」と報告してはならない**。差分を具体的に述べ、ユーザーに確認を求める。過去に「本来コミットしていないはずが実はコミットされていた」「Beadsが想定と違う状態だった」というケースが起きているため、ここで必ず立ち止まること。

---

## 15. HANDOVERメンテナンス規定

### 15-1. いつ・なぜ更新するか

- **毎Phase終了時に必ず更新する**(省略不可)。「Phase終了」とは、そのPhaseに対応するBeadsタスクをCLOSEDにする、またはユーザーから明示的にPhase完了の確認を得た時点を指す
- Phase途中の細かい作業単位ごとには更新しない(粒度が細かすぎると更新自体が形骸化する)。ただし§2「External Review状態」が変化した場合(承認/差し戻しいずれも)は、Phase完了を待たず即座に更新する
- 更新を怠ってはならない理由: このファイルの正確性が「過去チャットを読まなくても開発を継続できる」という本ファイルの存在意義そのものである。古い情報が残ると、次セッションが誤った前提で動く

### 15-2. どう更新するか

1. パートA(§1・8〜11)は**滅多に変わらない**。Phase完了ごとに機械的に書き換えるのではなく、実際に方針が変わった時のみ更新する
2. パートB(§2〜7・12〜13)は**毎Phase完了時に必ず書き換える**:
   - §2(現在のPhase/External Review状態): 区分を更新。External Review状態は「更新履歴」に行を追加する形で更新し、過去の記録は消さない
   - §3(今回完了した内容): 直近Phaseの実績に**置き換える**(過去Phaseの実績を積み上げて残さない — 履歴が必要な場合は各Phaseの`PHASE*-*.md`報告書を参照すればよく、本ファイルは常に「最新状態のスナップショット」であるべき)
   - §4〜§7・§12〜§13: 実際に`git status`・`bd show`等を実行して**実測値で**更新する(記憶や前回の記載を書き写さない)
3. パートC(§14〜16)は本ファイル自身の運用ルールであり、運用方法自体を変える時のみ更新する
4. **冒頭の「最終更新」日付と更新者を必ず更新する**
5. 大きな設計判断の変更(パートAの内容に反する決定をした等)があった場合は、単に書き換えるのではなく「なぜ変更したか」を1〜2行添える(暗黙の方針転換を残さない)

### 15-3. 毎Phase終了時の標準手順

以下を**この順序で**実施し、完了したら次に進む(逆順・並行実施は不可):

1. **HANDOVER更新** — 15-2に従いパートB・(該当すれば)パートAを更新
2. **Review Bundle作成** — §11の構成・落とし穴に従いZIPを構築
3. **HANDOVERのdry-run確認** — §14の手順を自分自身で実施し、更新後の記載と実測が一致することを確認する(一致しなければ1に戻る)
4. **提出** — Review Bundle・更新済みHANDOVER.mdをユーザーへ提出
5. **セッション終了** — 次セッションはユーザーからの新しいプロンプトを待つ

---

## 16. 将来計画: G-Brain移行方針

**現状**: `HANDOVER.md`は、gbrainプロジェクトの**現在の正式な引き継ぎ正本**である。新しいセッションはこのファイルを唯一の起点として開発を再開する(§14)。

**最終目標**: この運用は恒久的なものではない。最終的には**G-Brainをプロジェクト状態のSingle Source of Truth(唯一の正本)とする**。人間が`HANDOVER.md`を都度手動更新する現行方式は、その移行が完了するまでの**橋渡し的な正式運用**と位置づける。

**想定される移行後の構成**:

```
G-Brain(プロジェクト状態の唯一の正本)
      ↓  自動生成
HANDOVER.md(G-Brainから生成される成果物)
      ↓  参照
各AIセッション(Claude Code / Opus / Sonnet / その他)
```

**移行条件**: G-Brainが以下を自動的に保持・提供できるようになった時点で、`HANDOVER.md`は「人間/AIが手で書き続ける文書」から「**G-Brainから自動生成される成果物**」へ移行する。

- プロジェクト状態の保存・復元
- 設計判断の履歴(いつ・なぜその決定をしたか)
- 未完了事項の追跡
- 次Phaseの引き継ぎ情報

**移行後の`HANDOVER.md`の扱い**: 自動生成された読み取り専用のスナップショットとなり、§15のような手動メンテナンス手順は不要になる(生成ロジック自体のメンテナンスに置き換わる)。移行が完了するまでは、本ファイルは引き続き§14〜15の手順に従って人間/AIが手動で維持する現行の正式運用を継続する。

**現時点でのgbrainとG-Brainの関係**(誤解防止のための補足): gbrain(本プロジェクト)とG-Brainは別系統のシステムであり、本セクションはgbrainの状態管理を将来G-Brainへ委譲する**方針の明文化**であって、現時点で両者間に自動連携が実装されていることを意味しない。実装状況は各セッションの`git status`・Beadsで確認すること(推測でこの節の内容を実装済みとして扱わない)。
