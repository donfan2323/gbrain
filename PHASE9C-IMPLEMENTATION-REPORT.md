# Phase 9C — 実装報告書(Universal Audit Event Integration)

**日付**: 2026-08-02
**設計参照**: `PHASE9C-CURRENT-AUDIT-PATHS.md` / `PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md` / `PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md` / `PHASE9C-FAILURE-AND-DURABILITY-POLICY.md` / `PHASE9C-IMPLEMENTATION-SCOPE.md` / `PHASE9C-ACCEPTANCE-CRITERIA.md`(Stage3、REQUIRED=0まで6回のCorrection Passで収束済み)
**目標**: AUTHZ-INV-009(委任チェーンは監査で再構成できる)・AUTHZ-INV-013(成功・拒否・失敗のいずれも記録され、欠落は明示的に検知可能)の新規充足。AUTHZ-INV-001/004(Principal状態は認可判定に無関係)を破壊しないこと。

---

## 1. 実装したもの

### 1-1. スキーマ(migrate.ts v126〜v128)

- `audit_events`(27列・7インデックス・CHECK制約2本): `event_kind`/`channel_id`/`attribution_state`の3つのopen-world登録表(`audit_event_kinds`15種・`audit_channels`8種・`audit_attribution_states`11種)へFK。`principal_id → principals(id) ON DELETE RESTRICT`。`chk_audit_attribution`が`attribution_state='principal_attributed'`と`principal_id IS NOT NULL`の双方向一致を強制。`client_id`/`job_id`/`parent_event_id`は既存の正当なDELETE操作(hard delete client・queue物理削除・長時間ジョブの親子順序不定)を壊さないよう意図的にFKなし(3例外、設計文書§3-2)。
- `audit_events_compat`(v127): `mcp_request_log`(凍結レガシー表、射影のみ・backfillなし)と`audit_events`(`channel_id IN ('mcp_http','ingest_http')`限定)をUNION ALLする読み取り互換ビュー。`security_invoker=on`(Postgres限定、v120 page_linksと同一パターンでRLSバイパス再発防止)。
- `audit_events_attribution_gaps`(v127): 未帰属行の運用診断ビュー(`inferred_client_id`等はビュー上の派生列のみ・書き戻しなし)。
- `rls_principal_tables`(v128): `principals`/`principal_kinds`(Phase 9Bで新設されたがRLS backfill対象リストに未登録だった、`dashboard-m1ja3`)+`audit_events`本体+登録表3つにRLSを有効化(v37パターン、PGLite側はDDLごと除外——issue #395の既知障害再発防止)。
- `mcp_request_log`は物理的に一切変更しない(列追加・DROP・rename禁止)。新規書き込みはゼロになるが、既存行は互換ビュー経由で読み取り可能なまま。

### 1-2. Writer(`src/core/audit/`)

- `audit-events-writer.ts`: `writeAuditEvent()`単一エントリポイント。4クラス分岐(class1_issuance=同一トランザクション内fail-closed+SAVEPOINT有界リトライ、class1_revocation=fail-open+常時critical-failures記録、class2_denial/class3_success/class4_internal=fail-open・単発試行)。監査書き込みの成否が認可結果を変えないことをコードの構造自体で保証(`§7-1`)。
- `audit-events-redact.ts`: 既存`redactConnectionInfo`を再利用しつつ、`gbrain_at_`/`gbrain_rt_`/`gbrain_`裸鍵の3パターンを追加(実装時に発見した既存redaction漏れ、詳細は§4)。`AuditEventInput`型は`error_message`を`Omit`し`errorMessageRaw`のみ公開する型レベルの強制により、redaction経由なしでの直接書き込みを構造的に禁止。
- `audit-events-spill.ts`: 非同期I/O・rename-then-read方式のspillファイル(`audit-spill-pending.jsonl`)、破損/データ形状棄却行は`audit-spill-corrupt.jsonl`へ隔離、`replaySpill()`はON CONFLICT DO NOTHINGで冪等。
- `audit-events-metrics.ts`: `audit_write_failures_total`インメモリカウンタ(プロセス境界を明記)。
- `entrypoint-registry.ts`: IN対象6経路・OUT対象17経路(admin GET11+その他6)を宣言する登録簿。実行時のExpressルーティングスタック(`app.router.stack`)イントロスペクションと突き合わせるドリフト検知の基盤。

### 1-3. 配線(6 IN経路 + submit_agent)

`src/commands/serve-http.ts`(57箇所)+`src/core/operations.ts`(3箇所、submit_agentのdelegation.grant/deny)に`writeAuditEvent()`を配線: POST /webhooks/github・POST /token(client_credentials + authorization_code/refresh_token)・POST /revoke・POST /ingest・POST /mcp+/mcp-v2(全6分岐)・admin Authority変更9ルート(api-keys発行/失効・update-client-ttl・revoke-client・issue-magic-link+redemption・sign-out-everywhere等)・`submit_agent`(トランスポート非依存、stdio/HTTP両対応)。

`src/core/oauth-provider.ts`: `exchangeClientCredentials`/`exchangeAuthorizationCode`/`exchangeRefreshToken`に任意の`tx?: BrainEngine`引数を追加し、監査書き込みと同一トランザクションでトークンINSERTを実行できるようにした。実装完了後(Stage6)、この`tx`が一部の内部読み取り(クライアント検索・TTL probe等)にまで一貫して伝播していなかったため、PGLite特有の単一コネクション制約下でデッドロックする重大バグを検出・修正(§4参照)。

`/admin/api/requests`・`/admin/api/agents`・`/admin/api/stats`・`/admin/api/health-indicators`の4読み取りエンドポイントを`mcp_request_log`直読みから`audit_events_compat`参照へ向け替え。

### 1-4. CLI・doctor統合

`gbrain audit replay-spill|prune|status`(`src/commands/audit.ts`、`src/cli.ts`へ登録)。`gbrain doctor`へ`audit_durability`チェック追加(spill非空・破損行非空・critical-failures非空を検知、いずれか非ゼロならdoctorの集約ステータスを`unhealthy`化)。`/admin/api/health-indicators`へ`audit_write_failures_total`・`audit_spill_pending`を追加。

### 1-5. 静的チェック

`scripts/check-audit-registry-drift.sh`(新規): `serve-http.ts`のルート登録リテラルと`entrypoint-registry.ts`の宣言をテキスト抽出・diffする高速ゲート。`bun run verify`/`bun run check:all`へ配線。

---

## 2. 実装しなかったもの(意図的な対象外、全22項目)

`PHASE9C-IMPLEMENTATION-SCOPE.md`§6のNon-Goals全22項目をそのまま踏襲(改ざん検知・delegation_id列新設・孫委任・organization_id・execution_instance_id独立列・requireAdmin統一・stdio一般操作/ローカルCLI計装・admin GET監査・運用診断JSONL統合・minion_self_fix_log統合・mcp_request_log物理DROP・agent-audit.ts撤去・oauth-diagnostic.ts是正・hard→soft delete統一・backfill・一括再帰属・backfill_confidence列・自動削除retention job・spend系RLS・verifyAccessTokenキャッシュ/計装・--log-full-params既定変更・グローバル全順序保証)。うち実装時に新たに確定した2件の追加スコープ外(記録済み・別bdタスク化):

- **MinionQueue.add()の外部トランザクション対応**: `submit_agent`のdelegation.grant監査行は、キュー投入自体のトランザクションとは別(non-atomic best-effort)。`MinionQueue.add()`が`tx`を受け取れるようにする改修はシステム全体への影響範囲が大きく、今回は見送り(`dashboard-fanqq`)。
- **SDKマウント境界(`/authorize`・DCR `/register`・SDKフォールバックの`/token`,`/revoke`)の計装**: サードパーティコード(`@modelcontextprotocol/sdk`)であり直接編集できない。ミドルウェアラッパー方式の設計が別途必要(`dashboard-4xj73`)。

---

## 3. 実コードと設計文書の差異(発見した場合の報告)

Stage5実装中に設計文書からの逸脱・追加発見はゼロ(Stage3〜4のCorrection Pass 6回で技術的欠陥は実装前に解消済み)。Stage6テスト作成・Stage7内部レビュー中に発見した実装バグ2件・redaction漏れ1件・既存テスト回帰3件(いずれも設計からの逸脱ではなく実装バグ)は§4に記録。

---

## 4. 実装中・レビュー中に発見し、その場で修正したバグ

| # | 発見フェーズ | 内容 | 修正 |
|---|---|---|---|
| 1 | Stage6(test/audit-event-generation.test.ts作成中) | PGLite単一コネクション制約下でのデッドロック: `oauth-provider.ts`の`exchangeClientCredentials`/`exchangeAuthorizationCode`/`exchangeRefreshToken`が、`tx`を最終INSERTのみへ伝播し、クライアント検索・TTL probe・code/refresh-token消費DELETE等の事前読み取りは`this.sql`(プロバイダ自身のトップレベル接続)のままだった。`engine.transaction()`内から呼ばれると、同一PGLite接続を2つのハンドルで同時に握り合い、実PostgreSQLでは再現しない(コネクションプーリングがあるため)無期限デッドロックが発生。全クエリを`tx`スコープへ統一(`GBrainClientsStore.getClient()`にも`sqlOverride`引数追加)し修正。**全`/token`リクエストがPGLite本番運用でハングしうる重大な本番影響バグ**であり、即時修正・211/211回帰確認。 |
| 2 | Stage6(test/audit-redaction.test.ts作成中) | `gbrain_at_`/`gbrain_rt_`(アクセス/リフレッシュトークン)が既存の汎用32文字超hexパターンで捕捉されない: `\b`単語境界が`_`(単語文字)の直後では成立しないため。`known_prefix_secret`パターンへ両プレフィックス追加+新規`legacy_api_key`パターン追加(`gbrain_cl_`クライアントIDは意図的に非対象のまま維持)。 |
| 3 | Stage5(schema実装直後) | `test/principal-schema-parity.test.ts`/`test/principal-rollback-pglite.test.ts`/`test/schema-bootstrap-coverage.test.ts`(Phase 9B自身の既存テスト)が、pre-v125/pre-Phase 9Cブレインを模擬するDROP順序に新レイヤー(`audit_events`)の事前剥がしステップを持たず失敗。DROP順序へ`audit_events`関連オブジェクトの事前剥がしを追加、`PHASE9B-MIGRATION-AND-ROLLBACK.md`にもv5追記(Phase 9B外部承認済み内容は変更せず追記のみ)。 |
| 4 | Stage7(内部レビュー、実Postgres初回アクセス時) | `test/e2e/serve-http-oauth.test.ts`の2テストが、Phase 9Cカットオーバー後にゼロ行になった`mcp_request_log`を直接SELECTしたまま失敗(`PHASE9C-ACCEPTANCE-CRITERIA.md`§3が事前宣言していた既知の更新要否)。`audit_events_compat`参照へ書き換え。 |
| 5 | Stage7(内部レビュー、実Postgres初回アクセス時) | `test/e2e/principal-postgres.test.ts`(Phase 9B自身の実PGテスト)の3テストが`DROP TABLE principals`を実行しており、`audit_events.principal_id`FK(RESTRICT・CASCADE無し)により`2BP01`で失敗。`PHASE9B-MIGRATION-AND-ROLLBACK.md`v5追記が既に文書化していた前提条件どおり、Phase 9Cオブジェクトの事前DROPを追加。 |

いずれも「実PostgreSQLへのアクセスが本セッションで初めて可能になった」という環境変化によって初めて検出可能になったものであり(#1除く、#1はPGLite単一コネクション特有)、発見後は即座に修正・実測再検証済み(詳細は`PHASE9C-TEST-EVIDENCE.md`)。

---

## 5. 変更ファイル一覧

### 5-1. 新規ファイル(22)

```
PHASE9C-ACCEPTANCE-CRITERIA.md
PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md
PHASE9C-CURRENT-AUDIT-PATHS.md
PHASE9C-EVIDENCE-MANIFEST.md
PHASE9C-FAILURE-AND-DURABILITY-POLICY.md
PHASE9C-IMPLEMENTATION-SCOPE.md
PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md
PHASE9C-IMPLEMENTATION-REPORT.md(本書)
scripts/check-audit-registry-drift.sh
src/commands/audit.ts
src/core/audit/audit-events-metrics.ts
src/core/audit/audit-events-redact.ts
src/core/audit/audit-events-spill.ts
src/core/audit/audit-events-types.ts
src/core/audit/audit-events-writer.ts
src/core/audit/entrypoint-registry.ts
test/audit-compat-view.test.ts
test/audit-delegation-chain.test.ts
test/audit-entrypoint-coverage.test.ts
test/audit-event-foundation.test.ts
test/audit-event-generation.test.ts
test/audit-event-rollback-pglite.test.ts
test/audit-event-schema-parity.test.ts
test/audit-failure-policy.test.ts
test/audit-redaction.test.ts
test/e2e/audit-event-postgres.test.ts
```

### 5-2. 変更ファイル(19)

```
HANDOVER.md                              — 更新はStage8で実施(現状はPhase9Bコミット時点の記述のまま)
PHASE9B-MIGRATION-AND-ROLLBACK.md        — v5追記(Phase9C依存の明記のみ、既存内容不変更)
package.json                             — check:audit-registry-drift スクリプト追加
scripts/run-verify-parallel.sh           — CHECKS配列へ追加
src/cli.ts                               — audit コマンド登録
src/commands/doctor.ts                   — audit_durability チェック追加
src/commands/serve-http.ts               — 6 IN経路+admin9ルートへ監査計装配線、4読取エンドポイントrepoint、runServeHttp()戻り値追加、起動時drift警告
src/core/doctor-categories.ts            — audit_durability カテゴリ登録
src/core/migrate.ts                      — v126/v127/v128マイグレーション追加
src/core/oauth-provider.ts               — tx引数追加(3メソッド+issueTokens)+PGLiteデッドロック修正
src/core/operations.ts                   — submit_agentへdelegation.grant/deny計装、AuthInfo.credentialSource追加
src/core/pglite-schema.ts                — audit_events等のインラインDDL追加
src/core/schema-embedded.ts              — build:schema再生成
src/schema.sql                           — audit_events等のインラインDDL追加(Postgres正本)
test/authorization-invariant-matrix.test.ts — AUTHZ-INV-001/004維持のattribution_state中立性マトリクス追加
test/e2e/principal-postgres.test.ts      — Phase9Cオブジェクト事前DROP追加(§4-#5)
test/e2e/serve-http-oauth.test.ts        — mcp_request_log直読み2箇所をaudit_events_compatへ向け替え(§4-#4)
test/principal-rollback-pglite.test.ts   — DROP順序修正(§4-#3)
test/principal-schema-parity.test.ts     — DROP順序修正(§4-#3)
test/schema-bootstrap-coverage.test.ts   — DROP順序修正(§4-#3)
```

計48ファイル(新規28+変更20)。**[v2訂正]** 当初報告した「41」「44」は誤カウントだった。`git status --short`を単一の真実源として再取得した正しい内訳は、tracked modified 20件+untracked 28件=合計48件(機械生成台帳: Review Bundle `reports/file-count-ledger.txt`)。

---

## 6. Migration

- v126 `audit_event_foundation`: 登録表3つ+`audit_events`本体(27列7索引2CHECK)+RLS DO-block(Postgres限定、has_bypass判定でスキップ可)。
- v127 `audit_events_compat_view`: 互換ビュー2点+`security_invoker=on`(Postgres限定)。
- v128 `rls_principal_tables`: `principals`/`principal_kinds`RLS有効化(`dashboard-m1ja3`解消、Postgres限定)。
- 3件ともPGLite/Postgres両エンジンで`idempotent: true`。実PostgreSQLで新規インストール(123 migration適用)・アップグレード再評価(v124→v128、4 migration適用)・冪等再実行の3パターンいずれも実測確認済み(`PHASE9C-TEST-EVIDENCE.md`§3参照)。
- ロールバックSQL(`PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md`§6-2)はPGLite・実Postgresの両方で実行検証済み(`test/audit-event-rollback-pglite.test.ts`・`test/e2e/audit-event-postgres.test.ts`)。§6-1の自己復元欠陥(SQLロールバックのみではコードが再作成してしまう)は意図的挙動として回帰テストで固定。

---

## 7. Beadsタスク・Git状態

- 親タスク: `dashboard-zz21x`(P0、gbrain Phase 9C)。Stage1〜7完了、notes欄に全経緯記録済み。
- 副産物・残課題として登録した子タスク(全て独立に追跡・クローズ判断はPhase 9C範囲外):
  - `dashboard-fanqq`(P3・open): MinionQueue.add()外部トランザクション対応。
  - `dashboard-4xj73`(P2・open): SDK境界(/authorize・/register・SDKフォールバック/token,/revoke)の計装設計。
  - `dashboard-7dtcd`(P3・open): `audit_events_compat`のtoken_name述語が非sargable(COALESCE)、管理ダッシュボード低頻度読取のみ影響。
  - `dashboard-e9bl0`(P4・open): README.mdに`gbrain audit`サブコマンド未記載。
  - `dashboard-8xpiz`(P3・open): 既存`sql.array()`ドライバ互換性問題(Phase 9C無関係、`test/e2e/serve-http-oauth.test.ts`内)。
  - `dashboard-ebas5`(P3・open): 実PG初回フルE2E実行で判明したPhase 9C無関係の既存問題6件(真のバグ4件+false positive2件)。
  - `dashboard-blgxx`(closed・修正済み): serve-http-oauth.test.tsカットオーバー回帰。
  - `dashboard-k26fo`(closed・修正済み): principal-postgres.test.ts FK回帰。
- Working Tree: 48ファイル(新規28+変更20)、未コミット。ユーザーの明示承認・外部レビュー正式承認まで意図的にコミットを見送っている(Phase 9Bと同じ運用方針)。

---

## 8. 完了条件チェック

| 到達目標 | 判定 | 根拠 |
|---|---|---|
| AUTHZ-INV-009(委任チェーンは監査で再構成できる) | ✅ PASS | `test/audit-delegation-chain.test.ts`(8 tests)、job_id⇔delegation.grant双方向再構成をaudit_eventsのみから実証 |
| AUTHZ-INV-013(成功/拒否/失敗の記録・欠落の明示検知) | ✅ PASS | `test/audit-event-generation.test.ts`(14 tests、実HTTP)+`test/audit-failure-policy.test.ts`(20 tests)+`audit_events_attribution_gaps`ビュー |
| AUTHZ-INV-001/004非破壊 | ✅ PASS | `test/authorization-invariant-matrix.test.ts`(56 tests、grep静的検証+ランタイム証跡両方) |
| REQUIRED=0(Stage4設計レビュー) | ✅ PASS | 19→14→10→10→17→9→0(6 Correction Pass) |
| REQUIRED=0(Stage7内部レビュー) | ✅ PASS | 10カテゴリ全PASS、発見2件は同ラウンド内で修正・解消(`PHASE9C-REVIEW-MANIFEST.md`) |
| `PHASE9C-ACCEPTANCE-CRITERIA.md`§3全11ファイル+静的チェック1本 | ✅ PASS | 全て実在・green(`PHASE9C-TEST-EVIDENCE.md`) |

---

## 9. 残リスク・未実施事項

`PHASE9C-TEST-EVIDENCE.md`§末尾・`PHASE9C-REVIEW-MANIFEST.md`§末尾に集約。要旨:

1. **[v2で解消]** `scripts/run-unit-parallel.sh`全shard実行時の中断事象は、ラッパーを経由しない直接チャンク実行方式でbase/patched全1030ファイルの完全な機械diffを取得することで実質的に解消(詳細は`PHASE9C-EVIDENCE-MANIFEST.md`§6・`reports/regression-diff.txt`)。ラッパースクリプト自体を経由した実行のみ未実施として残る。
2. SDK境界(/authorize・DCR /register・SDKフォールバック/token,/revoke)は計装対象外のまま(サードパーティコード、`dashboard-4xj73`)。
3. `submit_agent`のdelegation監査書き込みはMinionQueue.add()と非atomic(best-effort、`dashboard-fanqq`)。
4. `audit_events_compat`の一部相関サブクエリが非sargable(`dashboard-7dtcd`、管理ダッシュボード低頻度読取のみ影響)。
5. 実PG初回フルE2E実行(160ファイル)で判明した、Phase 9C無関係の既存問題6件(`dashboard-ebas5`)。
