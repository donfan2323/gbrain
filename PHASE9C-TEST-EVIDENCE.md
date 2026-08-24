# Phase 9C — テスト証跡

**日付**: 2026-08-02
**環境**: bun 1.3.10、PGLite 0.4.3、実PostgreSQL 16(docker `gbrain-postgres-1`、`postgresql://postgres:postgres@localhost:5434/gbrain_test`)。実Postgresは本セッションのStage7レビュー中に初めてアクセス可能と判明し、Stage6完了時点で未実行だった`test/e2e/audit-event-postgres.test.ts`および周辺回帰確認を本ラウンドで完走させた。

---

## 1. 型チェック

```
$ bun run typecheck
$ tsc --noEmit
(出力なし = 成功、複数回・最終確認含め全て0エラー)
```

---

## 2. 静的チェック

```
$ bun run check:audit-registry-drift
[check-audit-registry-drift] ok: all N live route path(s) are declared in entrypoint-registry.ts
```
exit 0。故意にdrift(未宣言ルート)を注入したnegative-caseでもexit 1を確認済み(検出機構自体の健全性を確認)。

`bun run verify`(32チェック、`scripts/run-verify-parallel.sh`)は個別チェック単体では全てexit 0を確認済みだが、並列ラッパー実行時に本セッションのサンドボックス特有の`rc=143`アーティファクトが再現し、正確な集計サマリが取得できていない(生ログ本文には成功出力が記録されている)。個別再実行(`bun run check:audit-registry-drift`単体等)では問題なし。

---

## 3. Unit Tests(`PHASE9C-ACCEPTANCE-CRITERIA.md`§3、全11ファイル+条件付き4ファイル拡張)

| # | ファイル | 結果 |
|---|---|---|
| 1 | `test/audit-event-foundation.test.ts` | 20 pass / 0 fail |
| 2 | `test/e2e/audit-event-postgres.test.ts`(実Postgres) | 6 pass / 0 fail(54 expect calls) |
| 3 | `test/audit-event-schema-parity.test.ts` | 1 pass(32 assertions) |
| 4 | `test/audit-event-rollback-pglite.test.ts` | 5 pass / 0 fail |
| 5 | `test/authorization-invariant-matrix.test.ts`(拡張) | 56 pass / 0 fail |
| 6 | `test/audit-failure-policy.test.ts` | 20 pass / 0 fail |
| 7 | `test/audit-redaction.test.ts` | 32 pass / 0 fail |
| 8 | `test/audit-delegation-chain.test.ts` | 8 pass / 0 fail |
| 9 | `test/audit-compat-view.test.ts` | 9 pass / 0 fail(57 expect calls) |
| 10 | `test/audit-entrypoint-coverage.test.ts` | 13 pass / 0 fail |
| 11 | `test/audit-event-generation.test.ts`(実HTTP) | 14 pass / 0 fail |
| 静的 | `scripts/check-audit-registry-drift.sh` | exit 0 |

条件付き拡張(既存ファイルへの回帰対応、§3脚注どおり):

| ファイル | 結果 |
|---|---|
| `test/schema-bootstrap-coverage.test.ts` | green(前方参照bootstrap新規追加不要を確認) |
| `test/principal-schema-parity.test.ts` | green(DROP順序修正後) |
| `test/principal-rollback-pglite.test.ts` | 4 pass / 0 fail(DROP順序修正後) |
| `test/e2e/principal-postgres.test.ts`(実Postgres) | 13 pass / 0 fail(46 expect calls、修正後) |
| `test/e2e/serve-http-oauth.test.ts`(実Postgres) | 35 pass / 1 fail(修正後。残り1件は`dashboard-8xpiz`、Phase 9C無関係の既存`sql.array()`ドライバ互換性問題) |

複合実行(まとめ実行、回帰確認):

```
$ bun test test/schema-bootstrap-coverage.test.ts test/audit-event-foundation.test.ts test/audit-event-schema-parity.test.ts
30 pass / 0 fail / 133 expect() calls

$ bun test test/audit-failure-policy.test.ts test/doctor.test.ts
105 pass / 0 fail / 297 expect() calls

$ bun test test/audit-compat-view.test.ts
9 pass / 0 fail / 57 expect() calls

$ DATABASE_URL=... bun test test/e2e/schema-drift.test.ts   # 既存CIガード、Phase9C込みで再確認
6 pass / 0 fail / 11 expect() calls

$ DATABASE_URL=... bun test test/e2e/http-transport.test.ts test/e2e/auth-takes-holders-pglite.test.ts
14 pass / 0 fail / 43 expect() calls   # http-transport.tsは非対象dead codeパス、影響なしを確認
```

`test/audit-event-generation.test.ts`初回実行時にPGLiteデッドロックバグを検出(§実装報告書§4-#1参照)。修正後、OAuth+Phase9C回帰の全体スイート(既存125 oauth unitテスト含む)で211/211 pass、新規失敗ゼロを確認。

---

## 4. baseline運用(`PHASE9C-ACCEPTANCE-CRITERIA.md`§4)

事前宣言済み既知baseline失敗(Phase 9C変更を一切含まない作業ツリーでも再現、Beads `dashboard-2vepx`/`dashboard-nc8tl`):

1. `test/core/retry.test.ts` — 1件失敗(`BATCH_AUDIT_SITES`期待値欠落)。
2. `test/scripts/run-unit-parallel.test.ts` — 2件失敗(ラッパー自己テストの終了コード期待値不一致)。

本ラウンドでもこの3件は出現前提であり、新規失敗として誤認していない。**v2再提出ラウンドで、base commit(`fcdb7c47`)とpatched(現working tree)の2独立worktreeにより、fast unit test files 1030件全件(`test/e2e/*`・`*.slow.test.ts`・`*.serial.test.ts`を除く範囲)をテスト名レベルで機械比較するbaseline対比を実施・完了した**(詳細は`PHASE9C-EVIDENCE-MANIFEST.md`§6の再提出セクションおよびReview Bundle `reports/regression-diff.txt`参照)。結果: 失敗6件は全てbase側にも同一内容で存在(退行なし)。Phase 9C由来の新規失敗1件(`src/commands/audit.ts`のexit-verdict規約違反)を発見・修正・再検証済み(bd `dashboard-cc5pj`)。**この対比はunitテスト1030件の範囲に限定され、`scripts/run-serial-tests.sh`のbase/patched両完走、実PostgreSQL E2Eスイートのbase側実行、GitHub Actions実行は本ラウンドでも未実施(残リスクは`COMPLETION-REPORT.md`「Known constraints」参照)。プロジェクト全体の「フル回帰」が完了したものではない。**

---

## 5. 実Postgres フルE2Eスイート(初回完走、160ファイル)

Stage7レビュー中に実Postgres(docker `gbrain-postgres-1`)へのアクセスが可能と判明したため、`scripts/run-e2e.sh`(1ファイルずつ逐次実行、TRUNCATE CASCADE分離)を本セッションで初めて完走させた:

```
========================================
E2E SUMMARY (sequential execution)
========================================
Files: 160 total, 152 passed, 8 failed
Tests: 1098 passed, 14 failed
```

8失敗ファイルの内訳(全て個別ファイル単独再実行で追加調査済み):

| ファイル | 分類 | 判定根拠 |
|---|---|---|
| `serve-http-oauth.test.ts` | Phase9C回帰→修正済み | 修正後35/36 pass、残り1件は`dashboard-8xpiz`(既存ドライバ問題) |
| `dream-cycle-phase-order-pglite.test.ts` | 無関係・既存バグ | 単独実行でも再現(`embedding.ts`のexport欠落)、Phase9C差分に無関係 |
| `extract-atoms-discovery-sql.test.ts` | 無関係・既存バグ | 単独実行でも再現(4/4 fail、`discoverExtractablePages`のsourceIdスコープ漏れ) |
| `facts-fence-reconcile-postgres.test.ts` | 無関係・false positive | 単独実行では1/1 pass(160ファイル一括実行時のクロスファイルDB汚染疑い) |
| `facts-recall-render.test.ts` | 無関係・false positive | 単独実行では1/1 pass(同上) |
| `openclaw-plugin-load-real.test.ts` | 無関係・既存バグ | 単独実行でも再現(生成entry.jsのESM/バンドル不整合) |
| `phantom-redirect.test.ts` | 無関係・既存バグ | 単独実行でも再現(embedding列の型形状チェック) |
| `sync-lock-recovery.test.ts` | 無関係・環境依存 | `ZEROENTROPY_API_KEY`未設定によるメッセージ差異 |

Phase 9C由来の新規E2E失敗はゼロ(発見した2件は本ラウンド内で修正・実測再検証済み)。残り6件はPhase 9C範囲外の既存問題として`dashboard-ebas5`へ集約・記録。

---

## 6. Rollback実行(PGLite + 実Postgres)

- PGLite: `test/audit-event-rollback-pglite.test.ts`(5 tests)。`.exec()`によるBEGIN/COMMIT付き複数文実行で、§6-2の公表ロールバックSQLを実際に実行し、`config.version`巻き戻し・全Phase9Cオブジェクトの消失(カタログ照会+実クエリ両方)・`mcp_request_log`無傷・`initSchema()`再実行での完全復元・§6-1自己復元欠陥の意図的挙動固定、を実測確認。
- 実Postgres: `test/e2e/audit-event-postgres.test.ts`の最終テスト(`sql.begin(async tx => {...})`経由、Phase9B `principal-postgres.test.ts`前例踏襲)。同一手順を実PostgreSQL上で実行し、6/6 pass。RLS再有効化・登録表再シード(15種)・v128到達を実測確認。

---

## 7. git status --short(実測)

```
 M HANDOVER.md
 M PHASE9B-MIGRATION-AND-ROLLBACK.md
 M package.json
 M scripts/run-verify-parallel.sh
 M src/cli.ts
 M src/commands/doctor.ts
 M src/commands/serve-http.ts
 M src/core/doctor-categories.ts
 M src/core/migrate.ts
 M src/core/oauth-provider.ts
 M src/core/operations.ts
 M src/core/pglite-schema.ts
 M src/core/schema-embedded.ts
 M src/schema.sql
 M test/authorization-invariant-matrix.test.ts
 M test/e2e/principal-postgres.test.ts
 M test/e2e/serve-http-oauth.test.ts
 M test/principal-rollback-pglite.test.ts
 M test/principal-schema-parity.test.ts
 M test/schema-bootstrap-coverage.test.ts
?? PHASE9C-ACCEPTANCE-CRITERIA.md
?? PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md
?? PHASE9C-CURRENT-AUDIT-PATHS.md
?? PHASE9C-EVIDENCE-MANIFEST.md
?? PHASE9C-FAILURE-AND-DURABILITY-POLICY.md
?? PHASE9C-IMPLEMENTATION-REPORT.md
?? PHASE9C-IMPLEMENTATION-SCOPE.md
?? PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md
?? PHASE9C-REVIEW-MANIFEST.md
?? PHASE9C-TEST-EVIDENCE.md
?? scripts/check-audit-registry-drift.sh
?? src/commands/audit.ts
?? src/core/audit/audit-events-metrics.ts
?? src/core/audit/audit-events-redact.ts
?? src/core/audit/audit-events-spill.ts
?? src/core/audit/audit-events-types.ts
?? src/core/audit/audit-events-writer.ts
?? src/core/audit/entrypoint-registry.ts
?? test/audit-compat-view.test.ts
?? test/audit-delegation-chain.test.ts
?? test/audit-entrypoint-coverage.test.ts
?? test/audit-event-foundation.test.ts
?? test/audit-event-generation.test.ts
?? test/audit-event-rollback-pglite.test.ts
?? test/audit-event-schema-parity.test.ts
?? test/audit-failure-policy.test.ts
?? test/audit-redaction.test.ts
?? test/e2e/audit-event-postgres.test.ts
```

(`PHASE9C-IMPLEMENTATION-REPORT.md`/`PHASE9C-REVIEW-MANIFEST.md`/`PHASE9C-TEST-EVIDENCE.md`自身は本コマンド実行後にStage8で追加されたため上記リストに含む。)

---

## 8. 未実施のテストと理由(虚偽報告なし)

- `scripts/run-unit-parallel.sh`という**スクリプト自体**(並列ラッパー)を経由したフルshard実行: v2再提出時、このラッパー経由のバックグラウンド実行が本セッション環境で断続的に中断される事象を確認した(内容非依存、同一コマンドの再試行で成功する場合があることから、テストコード自体の欠陥ではなく環境固有の問題と判断)。**対処として、ラッパーを経由せず`bun test`を直接fast unit test files 1030ファイル全件に対して個別チャンク実行する方式に切り替え、base/patched両方でテスト名レベル機械diffを取得・完了した**(詳細は`PHASE9C-EVIDENCE-MANIFEST.md`§6・Review Bundle `reports/regression-diff.txt`)。したがって「unitテスト1030件スコープのbaseline対比の機械diffが未取得」という制約は解消済み。未実施のまま残るのは`run-unit-parallel.sh`という特定スクリプト経由での実行のみであり、**このunit 1030件スコープに限っては**テスト内容そのものの検証は完了している(serial/E2E-base/CIは別項目として下記に記載のとおり未実施)。
- `scripts/run-serial-tests.sh`のbase/patched両完走(serial-tagged tests): 本v2ラウンドでも完了していない。環境のバックグラウンドタスク不安定性への対処が、成功裏に完了した1030件のunit比較に時間の大半を要したため。serial-tagged test files はごく少数(`*.serial.test.ts`)であり、Phase 9Cのファイルもこのdiffが触れるファイルも含まれない。
- `docker-compose.ci.yml`ベースのCI環境そのものでの実行: 本セッションはローカルのdocker `gbrain-postgres-1`コンテナを利用しており、実際のCIパイプライン(GitHub Actions等)上での実行結果ではない。
- `scripts/run-e2e.sh`のbase commit側でのフル実行(160ファイル): 実施していない。実施理由の判断根拠は`PHASE9C-EVIDENCE-MANIFEST.md`§6参照(patched側の160ファイル完走+個別ファイルのbase相当ロジック無関係性確認により代替)。
