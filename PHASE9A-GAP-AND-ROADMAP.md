# Phase 9A — 現状と目標のギャップ・Phase 9B以降のロードマップ

**日付**: 2026-07-31(初版) / 2026-08-01(確定版 — Subject不採用・孫委任確定事実を反映)
**位置づけ**: `PHASE9A-CURRENT-STATE-AUDIT.md`(現状)と`PHASE9A-TARGET-DOMAIN-MODEL.md`(目標概念)の差分を整理し、実装順序案を提示します。**本書自体は実装計画の提案であり、Phase 9Aの範囲では一切のコード・スキーマ変更を行っていません。**

---

## 1. ギャップ一覧(現状 → 目標、10項目 — Subjectは独立ギャップとして扱わない)

> **2026-08-01改訂**: 初版では「Subject」を独立項目としてギャップに含めていましたが、`PHASE9A-IDENTITY-MODEL-DECISION.md`でSubjectは不採用(Principal+Clientの2層に統合)と確定したため、独立ギャップとしては扱いません。「1つのワイヤー識別子が複数の主体を代表する」というSubject導入の動機自体は、Principal(項目1)がClientとの`principal_id`参照によって既に解消します。

| # | 目標概念 | 現状の対応物 | ギャップの内容 | 深刻度 |
|---|---|---|---|---|
| 1 | Principal | なし | 人間/AI/サービス/デバイス/unknownを束ねる上位型が存在しない。`AuthInfo`はクライアントIDのみ保持。**Subjectという別レイヤーは不要と確定済み**(`PHASE9A-IDENTITY-MODEL-DECISION.md`) | 高(項目4・5 FAILの直接原因) |
| 2 | Client | `oauth_clients` | ほぼ対応済み。ギャップは小さい | 低 |
| 3 | Execution Instance | `minion_jobs`/`mcp_request_log`(いずれも既存主キーで代用可能、新規テーブル不要) | 非委任の通常リクエストと委任ジョブの識別子が相互参照されていない(`mcp_request_log`にjob_id列がない) | 中 |
| 4 | Credential | 3系統併存(OAuth/レガシーbearer/管理画面bootstrap)。GitHub Webhookの`webhook_secret`はSource帰属の別カテゴリ(メッセージ真正性検証用)であり、この3系統の一本化対象には含めない(`PHASE9A-CURRENT-STATE-AUDIT.md`§2「認証機構の分類」参照) | 3系統が統一されていない。管理画面はDB外・独自ライフサイクル | 高 |
| 5 | Session | OAuth側になし、管理画面のみ`adminSessions`(インメモリ) | OAuthトークン自体がセッション代替になっており、専用の追跡ができない | 中 |
| 6 | Delegation | `submit_agent`+`AgentClientBindings` | 実装は良好だが1階層(Client→Job)限定。**孫委任は現状不可能であることが確認済み**(未確認ではない — `PHASE9A-SUPPLEMENTAL-AUDIT.md`§4: `submit_agent`は`parent_job_id`不使用、subagentのツールレジストリに`submit_agent`自体が不在)。汎用化はPhase 9Eで新規実装が必要 | 中 |
| 7 | Capability/Permission | `scope.ts`の6値 | プロトコル非依存で良好。ただし`delete`が`write`と未分離という粒度の粗さ | 低〜中 |
| 8 | Policy Decision | `hasScope()` | MCP/HTTPは統一済み。管理画面(`requireAdmin`)は別系統で、判定が2つに分裂。GitHub WebhookはそもそもPolicy Decision自体に到達しない(構造的に別カテゴリ) | 高 |
| 9 | Audit Event | `mcp_request_log`+`agent-audit.ts`JSONL(2系統) | いずれもPrincipal/Delegationへの正式参照(FK)を持たない。JSONL側は書き込み失敗を握りつぶす。加えて記録範囲が経路ごとに非対称(`/ingest`拒否系統・CLI全体・管理画面全体・GitHub Webhookは無記録、`PHASE9A-SUPPLEMENTAL-AUDIT.md`§3で確認済み) | 高 |
| 10 | Organization/Tenant | なし(single-tenant by design) | データモデル全体に拡張点が存在しない。gbrain自身の既存設計文書(`docs/designs/MINIONS_AGENT_ORCHESTRATION.md`)が「Phase 3: Multi-tenant auth」として既に計画済みであり、既知・想定済みの欠落である | 高(ただし現時点で必須ではない、§4参照) |

---

## 2. 必須で変更が必要な項目(Mandatory Changes)

Universal Knowledge Layerの10項目判定でFAILとなった項目(4, 5, 9)に直結するもの:

1. **PrincipalとClientの帰属関係の導入**: `oauth_clients`に`principal_id`(nullable)を追加し、`AuthInfo`を拡張(オプショナルフィールド追加のみ)して、「このリクエストの背後にいる主体が何であるか」を表現できるようにする。Subjectという別レイヤーは導入しない(`PHASE9A-IDENTITY-MODEL-DECISION.md`で不採用と確定済み)。
2. **Credential系統の一本化、または明示的な階層化**: 3系統(OAuth/レガシーbearer/管理画面セッション)を、少なくとも「共通のPolicy Decisionを経由する」形に揃える。管理画面の`requireAdmin`が`hasScope()`を経由しない現状は、Universal化の最大の障害。
3. **Audit EventのFK整合性確保**: `mcp_request_log.token_name`/`agent_name`を`oauth_clients.client_id`への正式なFKに変更し、`agent-audit.ts`のJSONL監査もDBに統合するか、少なくとも失敗を握りつぶさない設計に変更する。

## 3. 現状維持でよい項目(What Can Stay)

- `scope.ts`のスコープモデル(6値フラット階層)は、プロトコル非依存・製品非依存という点でUniversal設計の要件を満たしている。粒度の粗さ(delete/write未分離)は将来の拡張課題ではあるが、Universal化の必須条件ではない。
- `oauth_clients`テーブルの構造(Client概念)は目標モデルとほぼ一致しており、変更不要。
- `submit_agent`の権限narrowing検証ロジック自体(サブセット検証)は健全であり、置き換える必要はない。拡張(汎用化)が必要なだけ。
- MCP/HTTPが共通の`requireBearerAuth`を通る現状の設計は、そのまま目標のPolicy Decision層の基盤として使える。

## 4. 廃止候補(Deprecation Candidates)

- **管理画面のインメモリ`adminSessions`**: DB非永続・単一の特殊認証系統であるため、将来的にはOAuthのCredential/Session系統に統合するか、少なくとも同じPolicy Decision層を経由させる方向が望ましい。ただし即時の廃止は管理画面全体の作り直しを意味するため、Phase 9Aでは「廃止候補」として記録するに留める。
- **レガシー`access_tokens`テーブル**: DCR以前の後方互換のためだけに存在する(Phase8調査で確認済み)。新規Universal設計では、Credential系統をOAuth 2.1に一本化し、このテーブルを段階的に廃止する方向が自然。ただし既存クライアントとの互換性次第であり、独自の移行計画が必要。
- **`minion_jobs.data->>'__owner_client_id'`という非正規化JSONBフィールドでの逆参照**: 正式なFK列に置き換えるべき。ただし既存データの移行が必要。

## 5. 移行リスク

| リスク | 内容 | 影響範囲 |
|---|---|---|
| OAuth互換性の破壊 | `AuthInfo`型の拡張は、それを消費する全operationハンドラ(`operations.ts`全体)に影響しうる | 高(本番コード全体) |
| MCP SDK契約との整合 | `oauth-provider.ts`は`@modelcontextprotocol/sdk`の`OAuthServerProvider`インターフェースを実装しているため、Principal概念(`principal_id`参照+`AuthInfo`拡張)の追加がSDK側の型契約と衝突しないか要確認 | 中〜高(外部ライブラリ依存) |
| 監査ログのFK化に伴うデータ移行 | 既存の`mcp_request_log`に蓄積された`token_name`文字列を、実際の`client_id`に紐付け直す必要がある(規約上一致しているはずだが、スキーマで保証されていなかったため、過去データに不整合がある可能性は未検証) | 中(データ移行、検証必須) |
| 管理画面認証の統合 | `adminSessions`をPolicy Decision層に統合する場合、bootstrap-token方式そのものの見直しが必要になる可能性がある(Phase 8で確認した「新規クライアント登録に再起動不要」という改善と関係する領域) | 高(認証フロー変更) |
| single-tenant前提の解消 | PGLiteが「single-tenant by design」と明記している以上、Organization/Tenant導入はPGLiteエンジン自体の設計変更、またはPostgres専用機能として切り分ける判断が必要 | 高(データベースエンジン選択に関わる) |

## 6. 後方互換性

- OAuth 2.1のクライアント登録・トークン発行・失効のプロトコル自体(外部から見えるHTTPインターフェース)は、Principal概念の導入だけでは変更する必要がない(内部実装の拡張として吸収可能、`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`で完全加算的であることを確定済み)。
- 既存の`connect.ts`が生成するクライアント設定(Claude Code/Codex/Perplexity向け)は、Client概念がほぼ現状のまま維持されるため、影響は小さいと考えられる。
- レガシー`access_tokens`の廃止は、既存のそのトークンを使っているクライアントに対して非互換になるため、廃止する場合は移行期間・deprecation通知が必須。

## 7. 推奨されるPhase 9B以降の分割案(依存関係付き)

> **本セクションはPhase 9A時点でのSonnetによる提案であり、確定した実装計画ではありません。** 分割・優先順位・実施の可否は、いずれもユーザーの別途承認を要します。Phase 9A自体はこの案を実行する権限を持たず、あくまで「現状監査から論理的に導かれる候補」を提示するに留まります。

```
Phase 9B: Principal概念の最小実装(Subjectは統合済み・不採用)
  └─ 依存: なし(Phase 9Aの完了のみが前提)
  └─ 内容: 詳細・確定範囲は`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`を正本とする(本書での重複記載は行わない)。
           要点: principalsテーブル+principal_kinds登録テーブル(案A=基盤のみ、管理画面CRUD等はPhase 9B対象外)

Phase 9C: Audit Event統合(mcp_request_logのFK化 + agent-audit.tsのDB統合)
  └─ 依存: Phase 9B(Principal概念が確定していないとFK先が定まらない)
  └─ 内容: スキーマ変更(マイグレーション)、既存ログデータの整合性検証

Phase 9D: Policy Decision層の一本化(管理画面requireAdminの統合)
  └─ 依存: Phase 9B, 9C(監査証跡が一本化されていないと、管理画面の操作も追跡できない)
  └─ 内容: adminSessionsをCredential/Session概念に統合する設計、または明示的な別レーンとして正式に位置づけるかの判断

Phase 9E: Delegation汎用化(submit_agentの1階層限定を解消)
  └─ 依存: Phase 9B(Principal間の委任として一般化するため)
  └─ 内容: 現状不可能であることが確認済みの孫委任(サブジョブのさらに配下)を新規実装する場合の権限継承ロジック設計、既存AgentClientBindingsとの互換性確保

Phase 9F: レガシーCredential系統の整理(access_tokens廃止計画)
  └─ 依存: Phase 9B, 9D(Credential統一後でないと安全に廃止できない)
  └─ 内容: 移行期間の設計、既存クライアントへの通知計画

Phase 9G(将来・優先度低): Organization/Tenant概念の導入検討
  └─ 依存: Phase 9B〜9F全て(Principal/Policy Decision/Audit Eventが固まってからでないと、テナント境界の設計ができない)
  └─ 内容: PGLite/Postgresでの扱いの違いの整理、single-tenant前提の解消方針
```

**優先順位の根拠**: Phase 9B(Principal)が最初に来るのは、他の全てのギャップ(Audit EventのFK先、Policy Decisionの統合対象、Delegationの一般化対象)がPrincipal概念に依存しているためです。Organization/Tenant(9G)を最後に置くのは、現状の10項目判定で必須ではなく(項目9はFAILだが、他の9項目に比べて緊急性が低いと判断)、かつPGLiteのsingle-tenant前提という根本的な制約に触れるため、他の変更が固まってから着手すべきと考えるためです。

## 8. ロールバック方針

- Phase 9B以降の各Phaseは、それぞれ独立したBeadsタスク・独立したコミット単位で実施し、各Phase完了時点でgitタグまたはコミットSHAを記録する。
- スキーマ変更を伴うPhase(9C, 9F, 9G)は、必ずマイグレーションのdown方向(ロールバック用SQL)を事前に用意してから適用する。
- 認証・認可フローに変更を加えるPhase(9D)は、本番切替前にステージング環境(または開発用インスタンス)で、Phase8で使用した既存の3クライアント(Claude Web/Codex-CLI/Hermes-Agent)による実機テストを再実施し、非破壊を確認してから適用する。
- いずれのPhaseも、CONSTITUTION.md RULE-6(レビュー運用)に基づき、実装後は外部敵対的レビュー(ChatGPT等)を経てからクローズする。

---

## 未確定・要追加判断事項

- 管理画面認証(`adminSessions`)を統合するか、独立した認証レーンとして正式に位置づけるかは、Phase 9B着手前にユーザー判断が必要(本書では両論併記に留めた)。
- Organization/Tenant導入の要否自体(そもそも複数組織展開の実需要があるか)は、Phase 9Aの調査範囲外であり、ユーザー側のビジネス要件確認が前提となる。
