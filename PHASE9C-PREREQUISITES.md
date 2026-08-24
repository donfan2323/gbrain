# Phase 9C 前提条件・依存関係整理(実装なし)

**日付**: 2026-08-02
**目的**: Phase 9B(Universal Identity Foundation — Principal基盤)の内部レビュー(7専門Reviewer、2ラウンド)で得られた知見をもとに、Phase 9C(Audit Event統合、想定)開始前に整理しておくべき前提条件・依存関係・既知の制約をまとめる。**本ドキュメントは実装を含まない。** 着手判断・優先順位付けはユーザーが行う。

---

## 1. Phase 9Cのスコープ想定(Phase 9B設計文書からの継承)

`PHASE9B-REVIEW-MANIFEST.md`§10(Phase 9C〜9J見取り図)より:

> Phase 9C(Audit Event統合): `principals`テーブルが既に存在するため、`mcp_request_log`への`principal_id`参照FK追加は素直に乗る。

Phase 9Bは意図的に`mcp_request_log.job_id`(Phase 9Cへ送る対象として§2「実装しなかったもの」に明記済み)を対象外としており、Phase 9Cの主眼は監査ログとPrincipalの紐付けになる見込み。

---

## 2. 前提として押さえておくべきPhase 9Bの設計制約

### 2-1. Principal状態は認可に一切影響しない(AUTHZ-INV-001〜004)

Phase 9B全体を通じて最も重要な不変条件: `principal_id`・`kind_id`・`revoked_at`のいずれも、スコープベースの認可判定(`hasScope`/`authorizeOperation`)に影響を与えない。Phase 9Cで監査ログにPrincipal情報を統合する際も、**この不変条件を破らないこと**が絶対条件(`PHASE9A-AUTHORIZATION-INVARIANTS.md`が正本)。監査目的でPrincipal情報を「参照」することと、認可判断に「利用」することは明確に別物として扱うこと。

### 2-2. `principal_id`は`ON DELETE RESTRICT`(v5内部レビューでSET NULLから変更)

`oauth_clients.principal_id`のFKは物理削除を拒否する設計になった(Principal行は設計上そもそも物理削除されない想定だが、万一の削除試行時に監査参照を無言で破壊しないため)。Phase 9Cで`mcp_request_log`に同様のFKを追加する場合、**同じ設計判断(RESTRICT、SET NULLではない)を踏襲することを推奨**。理由は`PHASE9B-IMPLEMENTATION-REPORT.md`§11 REQUIRED-Aを参照。

### 2-3. 3つのAuthInfo構築経路のうち2つは構造的にPrincipal帰属不可能

Architecture Reviewerが内部レビューで発見・`PHASE9B-IMPLEMENTATION-REPORT.md`§3-1に文書化済み: `AuthInfo`は(a)`oauth-provider.ts`のOAuthパス、(b)同ファイルのレガシー`access_tokens`パス、(c)`src/mcp/http-transport.ts`のレガシーパス、の3箇所で構築される。Principal帰属(`principalId`/`principalKind`)を持てるのは(a)のみ。**特に(b)は`scopes: ['read', 'write', 'admin']`を無条件に返す**——最も強い権限を持つ経路が最も帰属不可能という組み合わせになっている。

**Phase 9Cへの直接的示唆**: `mcp_request_log`とPrincipalを統合する際、(b)(c)経由の操作を「未帰属のOAuthクライアント」(`principal_id IS NULL`)と同一のNULLへ畳み込んではならない。「この認証方式では帰属が構造的に取得不可能」として区別できる設計にする必要がある。区別しない場合、監査ログ上で「admin操作を誰が行ったか」という問いに対し、レガシートークン経由の操作だけが常に無言で答えられない状態になる。

---

## 3. Phase 9C着手前に解消しておくと安全な既存の技術的負債

内部レビューで発見され、Phase 9B自体のスコープ外として今回はBeadsへ登録するに留めた項目。優先度は参考(P3〜P4、いずれもブロッカーではない)。

| Beads ID | 内容 | Phase 9Cとの関連 |
|---|---|---|
| `dashboard-feibe` | pre-v125 brainは`verifyAccessToken`がリクエスト毎に認証往復2倍・エラー1行を無期限に払う | Phase 9Cで識別情報の列を追加する前に、初回プローブ後の検出結果をproviderインスタンス上でメモ化する構造修正が推奨 |
| `dashboard-ikosb` | `verifyAccessToken`にキャッシュが無く、将来のJOIN追加が乗算的にコスト増する | Phase 9Cがこの関数(監査ログ書き込みを含む可能性が高い)に触れる前に、tokenHashをキーとした短TTLキャッシュの追加を検討 |
| `dashboard-m1ja3` | `principals`/`principal_kinds`テーブルがv24 RLS backfillの静的管理リストに未登録 | Phase 9Cで`mcp_request_log`とのJOINが増える前に、DB/セキュリティ観点でRLS方針を明示的に決定しておくことを推奨 |
| `dashboard-84p97` | `pglite-engine.ts`/`postgres-engine.ts`の`probe as unknown as`キャストが型安全性を迂回 | Phase 9Cでbootstrap経路に触れる際、適切な型定義への置き換えを検討 |
| `dashboard-5qp17` | `Scope`型が`operations.ts`/`scope.ts`で3重定義 | Phase 9Cで新しいoperationやscopeを追加する前に、`Operation.scope`を`Scope`型からimportする形に統一しておくと安全 |
| `dashboard-vg25p` | `gbrain apply-migrations --force-schema`が`pg_advisory_lock(42)`を取らない | Phase 9Cのマイグレーション追加時、ロールバック直後の運用手順との相互作用に注意 |
| `dashboard-bvz6l` | `principals.revoked_at`がどこからも参照されていない | Phase 9Cで監査ログにPrincipal状態を統合する際、`revoked_at`を読み取り専用の付帯情報として扱うか、認可へ波及させない設計を維持すること(2-1参照) |
| `dashboard-r3be4` | Postgres側`verifySchema`のself-heal経路がFK句を除去し`principal_id`をFKなしで復元しうる | 到達条件は現状レア(bootstrapが先に走る)だが、Phase 9Cでbootstrap順序に変更を加える場合は要再確認 |

---

## 4. Phase 9Cのスコープ順序に関する示唆(Architecture Reviewer所見)

過去のPhase 9設計レビュー(本ラウンド以前)で、Architecture ReviewerからOrganization/Tenant導入(Phase 9G相当)より前にPhase 9C(Audit)を先行させる順序についての整合性懸念が出ていた記録がある(`principals`テーブルへの`organization_id`列追加余地は`ALTER TABLE ADD COLUMN`一つで将来対応可能な設計にしてあるため、Phase 9Cの前にOrg/Tenantを先取りする必要はない、というのが現在の設計判断)。Phase 9C着手時に、この順序判断が依然妥当かどうかを再確認することを推奨。

---

## 5. 本ドキュメントで扱わなかったもの

- Phase 9Cの詳細設計(データモデル・API・マイグレーション番号等)——本ドキュメントは前提整理のみで、設計はPhase 9C着手時に`architect`エージェント等を通じて別途行う。
- 外部レビュー(ChatGPT)によるPhase 9B自体の正式承認——これは本ドキュメントの範囲外であり、Phase 9C着手の可否とは別に、引き続きユーザーの確認が必要。
