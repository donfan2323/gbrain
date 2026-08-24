# Phase 9B — 実装範囲確定候補資料(実装指示ではない)

**日付**: 2026-08-01(初版) / 2026-08-01(確定版 — 案A採用・全任意項目を決定済みに変更)
**位置づけ**: 本書はPhase 9B実装プロンプトを作るための確定候補資料であり、実装指示そのものではない。Phase 9Bの実装はまだ開始していない。`PHASE9A-IDENTITY-MODEL-DECISION.md`・`PHASE9A-AUTHORIZATION-INVARIANTS.md`・`PHASE9A-SUPPLEMENTAL-AUDIT.md`の結論を踏まえ、必要最小限の範囲を提示する。

> **2026-08-01改訂の要点**: 初版に残っていた「任意」「実装時に判断」という未決定状態を全て解消した。管理画面Principal CRUD・`/admin/api/principals`・Principal失効操作・既存Clientへの手動紐付け手段は**Phase 9B対象外として確定**。`mcp_request_log.job_id`は**Phase 9Cへ先送りと確定**。Principal種別の保存方式は**`principal_kinds`登録テーブル参照方式に確定**(`PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1a)。Phase 9BでPrincipalを操作可能にする範囲は**案A(基盤のみ)に確定**(同§7)。

---

## 1. Phase 9Bの正確な目的

**「Principal概念を最小構成で導入し、既存のClient(`oauth_clients`)から任意参照できるようにする」こと。それ以上でもそれ以下でもない。**

`PHASE9A-GAP-AND-ROADMAP.md`の原提案「Principal/Subject概念の設計・最小実装」から、`PHASE9A-IDENTITY-MODEL-DECISION.md`での決定(Subject不採用・Session/Execution Instance新規テーブル不要)を反映し、範囲を絞り込んだ。**Phase 9Bは「データモデルと認証コンテキストの下地」のみを用意するフェーズであり、実運用上Principalを作成・紐付ける手段は含まない**(§5 案A参照)。

---

## 2. 実装対象(確定)

- 新規テーブル`principals`(最小列構成: `id`, `kind_id`(`principal_kinds(id)`への外部キー、`NOT NULL DEFAULT 'unknown'`), `display_name`(nullable), `created_at`, `revoked_at`(nullable、ただしPhase 9Bでは書き込むコードパスを持たない。§4参照))
- 新規テーブル`principal_kinds`(登録テーブル: `id TEXT PRIMARY KEY`, `label TEXT NOT NULL`, `description TEXT NULL`)。ブートストラップ行として`human`/`service`/`agent`/`device`/`unknown`の5件を初期投入する
- `oauth_clients`への`principal_id`(nullable, `principals.id`への外部キー)列追加
- `AuthInfo`型(`operations.ts`)へ`principalId`(nullable)・`principalKind`(nullable、`principal_kinds.label`を解決した文字列)フィールドの追加(既存フィールドは変更しない、純粋な追加)
- `verifyAccessToken`相当の箇所で、`oauth_clients`とのJOINに`principal_id`/`principals.kind_id`/`principal_kinds.label`を含めるよう1箇所拡張
- AUTHZ-INV-012を満たすための確認: 新規Client登録時に`principal_id`が既定でnullになることを保証するテスト

---

## 3. 実装対象外(確定 — 「任意」「検討中」は残さない)

| 項目 | 対象内/対象外 | 先送り先 |
|---|---|---|
| Subject | 対象外(不採用) | なし(統合済み) |
| Session専用の新規テーブル | 対象外(既存`oauth_tokens`/`adminSessions`のまま) | なし |
| Execution Instance専用の新規テーブル | 対象外(既存`mcp_request_log.id`/`minion_jobs.id`のまま) | なし |
| Delegationの汎用化・孫委任対応 | 対象外 | Phase 9E |
| 管理画面`requireAdmin`とPolicy Decisionの統合 | 対象外 | Phase 9D |
| `access_tokens`(レガシー)の廃止・変更 | 対象外 | Phase 9F |
| `mcp_request_log`のFK化・Audit Event統合全般 | 対象外 | Phase 9C |
| **`mcp_request_log.job_id`列の追加** | **対象外(確定)** | **Phase 9C**(Audit Event統合の一部として実施する) |
| Organization/Tenant | 対象外 | Phase 9G |
| GitHub Webhook・CLI・`/ingest`拒否系統への監査記録追加 | 対象外 | Phase 9C以降 |
| **管理画面Principal CRUD(UI)** | **対象外(確定)** | Phase 9D以降で必要に応じて検討 |
| **`/admin/api/principals`(API)** | **対象外(確定)** | Phase 9D以降で必要に応じて検討 |
| **Principal用CRUDモジュール(製品機能としての作成/更新API)** | **対象外(確定)**。ただしテスト用にSQLで直接行を作成する内部ヘルパーはテストコード内に限り持つ(製品機能ではない) | Phase 9D以降 |
| **Principal失効操作(製品機能)** | **対象外(確定)**。`revoked_at`列は存在するが、Phase 9Bのコードパスはこれに一切書き込まない | Phase 9D以降 |
| **既存Clientへの手動紐付け手段(製品機能)** | **対象外(確定)**。運用者が独自にSQLで直接`principal_id`を設定することを妨げないが、非サポートでありPhase 9Bの完了条件には含めない | Phase 9D以降 |

---

## 4. 変更候補ファイル

| ファイル | 変更内容 |
|---|---|
| `src/schema.sql`, `src/core/pglite-schema.ts`, `src/core/schema-embedded.ts`, `src/core/migrate.ts` | `principal_kinds`テーブル(+ブートストラップ5行)のCREATE TABLE追加、`principals`テーブルのCREATE TABLE追加、`oauth_clients.principal_id`列追加(いずれも既存の複数スキーマ表現先すべてに反映する既存の慣行に従う) |
| `src/core/operations.ts` | `AuthInfo`型に`principalId`/`principalKind`フィールド追加(オプショナル)。既存フィールドは無変更 |
| `src/core/oauth-provider.ts` | トークン検証時のJOINクエリに`principal_id`/`kind_id`/`principal_kinds.label`を含める1箇所の拡張 |

**`src/commands/serve-http.ts`への変更は行わない**(管理画面APIの追加はPhase 9B対象外、§3参照)。

## 5. Phase 9BでPrincipalを操作可能にする範囲(確定 — 案A採用)

「案A: 基盤のみ」と「案B: 最小運用可能単位」を比較し、**案Aを採用する**(`PHASE9A-IDENTITY-MODEL-DECISION.md`§7と同一の結論)。

- 実装するもの: `principals`/`principal_kinds`テーブル、`oauth_clients.principal_id`、`AuthInfo`への読み取り専用の情報追加、内部モデル・テストのみ。
- 実装しないもの: Principal作成・紐付けUI/API/CLI全般(§3の確定表を参照)。
- 結果: **全既存Clientの`principal_id`はnullのまま**であり、Phase 9B完了時点では実運用上Principalを設定する製品機能が存在しない。これは意図した設計であり、完了条件の未達ではない。

## 6. 新規ファイル候補

- `src/core/principals.ts`は**作らない**。Phase 9Bでは製品機能としてのCRUDを提供しないため(§3・§5参照)、テスト内で直接SQLを発行するテストヘルパーのみで足りる。
- マイグレーション定義は既存の`migrate.ts`内のマイグレーション配列に追記する(gbrainの既存パターンに従う。新規マイグレーションファイルは不要)。

## 7. DB変更(確定)

- `CREATE TABLE principal_kinds (id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT)` — 加算のみ。`human`/`service`/`agent`/`device`/`unknown`の5行をブートストラップ。
- `CREATE TABLE principals (id, kind_id REFERENCES principal_kinds(id) NOT NULL DEFAULT 'unknown', display_name, created_at, revoked_at)` — 加算のみ、既存データへの影響なし。
- `ALTER TABLE oauth_clients ADD COLUMN principal_id ... REFERENCES principals(id)` — nullable、既定値null、既存行は全てnullのまま(§9の後方互換性参照)。
- `mcp_request_log.job_id`の追加は**行わない**(Phase 9Cへ確定的に先送り、§3参照)。

## 8. API変更の有無

- MCP/HTTP/CLIの外部インターフェースへの変更は**なし**。`AuthInfo`への追加フィールドは内部型の拡張であり、既存のMCP operation・HTTPレスポンス形状には影響しない。
- 管理画面APIへの追加は**行わない**(§3・§5で確定)。

## 9. 互換性方針

- 完全加算的(additive-only)。既存の`oauth_clients`行は全て`principal_id = null`のまま動作し続ける。
- 既存のOAuth・MCP・Connector・API互換性への影響はゼロ(いずれのプロトコルの外部契約も変更しない)。
- `AuthInfo`の既存フィールドは変更しない。新規オプショナルフィールドの追加のみ。

## 10. 移行方針

- 既存の`oauth_clients`データに対する自動バックフィルは行わない(誰が「本人」かをシステム側で推測することはAUTHZ-INV-003違反になりうるため)。
- 運用者が独自に、自分自身のPrincipal行をSQLで直接作成し、既存の自分名義のClientに`principal_id`を手動設定することを技術的に妨げはしないが、これは非サポートの操作であり、Phase 9B完了の条件には含めない(§3参照)。

## 11. Principal失効(`revoked_at`)のPhase 9B上の意味(確定)

`PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1bと同一の結論を、実装範囲として明記する。

- Phase 9Bは**完全加算的・認可挙動不変**とする。
- **`principal_id`およびPrincipalの状態(`revoked_at`を含む)は、Phase 9Bでは認可判断に一切使用しない。**
- Principal失効はPhase 9Bでは帰属情報上の状態のみであり、紐付くClientの認証・トークン有効性・scope認可のいずれにも影響しない。
- 認証・認可への失効伝播は、管理画面統合を扱うPhase 9D以降で設計・実装する。
- したがって、Phase 9Bでは**Principal失効操作(製品機能)を管理画面へ公開しない**(§3で確定済み)。`revoked_at`列はスキーマ上存在するが、Phase 9Bのコードは一切書き込まない。

## 12. テスト計画

**新規に必要なテスト**:
- `principal_kinds`のブートストラップ行(5件)が存在することの確認テスト
- `principals`テーブルへのテスト用直接INSERT(製品APIではなくテストヘルパー経由)による作成・失効状態設定の単体テスト
- 新規Client登録直後の`principal_id`が既定でnullであることの確認テスト(AUTHZ-INV-012)
- `AuthInfo`に`principalId`/`principalKind`が正しく反映されること(Principal紐付けあり/なし双方のケース)
- Principal種別が異なっても同一scopeなら認可結果が変わらないこと(AUTHZ-INV-001)の確認テスト
- **Principal失効(`revoked_at`セット)がそのPrincipalに紐づくClientの認証・認可に一切影響しないことの確認**(§11の設計の裏付け——「Principal失効でClientも道連れに無効化される」ような実装になっていないかを確認する重要な回帰テスト)

**既存テストへの影響**:
- `AuthInfo`型を消費する既存のoperationハンドラ・テストは、新規オプショナルフィールドの追加のみであるため、型レベルでの破壊的変更はない。`AuthInfo`のシェイプをスナップショット的に検証している既存テストがあれば新フィールド追加により差分が出る可能性があるため、実装時に既存テストスイートを実行して確認する(実装時の実務的確認事項であり、設計上の未確定事項ではない)。

## 13. ロールバック

- `ALTER TABLE oauth_clients DROP COLUMN principal_id;` → `DROP TABLE principals;` → `DROP TABLE principal_kinds;` の順で完全にロールバック可能。
- `AuthInfo`型のオプショナルフィールド削除もコード上のロールバックのみで完結する。
- 他のいかなるテーブル・機能もこの変更に依存しないため、ロールバックの影響範囲はPhase 9Bの変更点自体に閉じる。

## 14. 完了条件

- `principal_kinds`テーブルが作成され、5件のブートストラップ行が存在する
- `principals`テーブルが作成され、既存スキーマ表現(schema.sql/pglite-schema.ts/schema-embedded.ts/migrate.ts)全てに反映されている
- `oauth_clients.principal_id`が既存データに対してnullで安全に追加されている
- `AuthInfo`に`principalId`/`principalKind`が追加され、既存のoperationハンドラが無変更で動作する
- §12の新規テストが全て通過する
- 既存のOAuth・MCP・HTTP・CLI・Connector互換性テスト(Phase 8で使用したClaude Web/Codex-CLI/Hermes-Agentのクライアント登録・利用シナリオ)が引き続き成功する
- 管理画面Principal CRUD・`/admin/api/principals`・Principal失効操作・既存Clientへの手動紐付け手段のいずれも実装されていないことを確認する(§3の対象外確定事項が守られていることの確認)

## 15. Phase 9C以降との境界

- Phase 9C(Audit Event統合): `mcp_request_log`のFK化・`agent-audit.ts`のDB統合・**`mcp_request_log.job_id`列の追加**は、Phase 9Bで導入した`principals`テーブルへの参照を前提にできる(依存関係: 9B→9C)。
- Phase 9D(Policy Decision統合): 管理画面`requireAdmin`の統合、**Principal CRUD・失効操作の製品機能としての実装**、Principal失効の認可への伝播設計は、いずれもPhase 9Dで扱う。
- Phase 9E(Delegation汎用化): 孫委任実装時、AUTHZ-INV-006〜009が本格的に適用される。Phase 9Bはこれらの委任ロジック自体には触れない。

Phase 9Bの範囲は上記の通り、新規テーブル2つ・列1つ・型フィールド2つの追加という、意図的に小さい変更に留める。「全ての概念を一度にDBへ実装する」ことはしない。本書に残る未決定事項はない。
