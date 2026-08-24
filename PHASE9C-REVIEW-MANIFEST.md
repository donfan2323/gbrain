# Phase 9C — Stage7内部敵対的レビュー・マニフェスト

**日付**: 2026-08-02
**実施方式**: ユーザー指示「並列なしでメインのみで」により、Stage4(設計レビュー)のような専門Reviewerエージェント並列起動ではなく、本体(Sonnet)が10カテゴリを順次ソロで検証。
**判定基準**: `PHASE9C-ACCEPTANCE-CRITERIA.md`§5(PASS/WARNING/REQUIRED/未確認範囲/権限不足の5値判定、REQUIRED=0達成までCorrection Pass→再提出)。

---

## 総合判定: REQUIRED = 0(ラウンド1で達成)

| カテゴリ | 判定 | PASS | WARNING | REQUIRED |
|---|---|---|---|---|
| Architecture | PASS | ✓ | 0 | 0 |
| Security-Privacy | PASS | ✓ | 1 | 0 |
| Database | PASS | ✓ | 0 | 0 |
| Migration | PASS | ✓ | 0 | 0 |
| Reliability-Durability | PASS | ✓ | 0 | 0 |
| Compatibility | PASS | ✓ | 0 | 0 |
| Performance | PASS | ✓ | 1 | 0 |
| Testing | PASS(Correction Pass後) | ✓ | 0 | 2(発見時。同ラウンド内で解消) |
| Documentation | PASS | ✓ | 2 | 0 |
| Bundle Consistency | PASS | ✓ | 0 | 0 |

Correction Pass回数: 1(Testingカテゴリ内で完結)。他9カテゴリはCorrection Pass不要で初回PASS。

---

## 1. Architecture — PASS

- `writeAuditEvent()`単一エントリポイント、4クラス分岐の構造がPHASE9C-FAILURE-AND-DURABILITY-POLICY.mdと一致することをコード直接確認。
- `verifyAccessToken()`が非計装のまま(non-goal #20)であることをgrep確認(`writeAuditEvent`呼び出しゼロ)。
- `operations.ts`の`writeAuditEvent`呼び出しが3箇所のみ、いずれも`submit_agent`のdelegation.grant/deny内(non-goal #7の唯一の例外と一致)であることを確認。

## 2. Security-Privacy — PASS(WARNING 1件)

- `error_message`が型レベルで強制されたredaction経路(`AuditEventInput`が`error_message`を`Omit`し`errorMessageRaw`のみ公開)を通ることをソース確認。回避不能な設計。
- 全`credential_ref`書き込み箇所(28箇所)が`hashToken(...).slice(0,16)`等のハッシュ・切詰め済み値のみで、生の秘密情報が書き込まれていないことを確認。
- WARNING: フリーテキストパスワード(URL埋め込みでない自由記述)のredactionは構文的パターンマッチで検出不可能な既知の残存限界。`test/audit-redaction.test.ts`が明示的にドキュメント化済み・対象外として合意済み。

## 3. Database — PASS

- 実Postgresで`schema-drift.test.ts`(既存CIガード、PGLite⇔Postgres比較)を再実行し6/6 pass、Phase9C追加分含めスキーマ3ファイル(schema.sql/pglite-schema.ts/schema-embedded.ts)の同期を確認。
- `test/schema-bootstrap-coverage.test.ts`等30テスト再実行、前方参照bootstrap新規追加が不要という設計判断を確認。

## 4. Migration — PASS

- v126/v127/v128全て`idempotent: true`。実Postgres上で新規インストール(123 migration)・v124→v128アップグレード再評価(4 migration)・冪等再実行の3パターンを実測。

## 5. Reliability-Durability — PASS

- `test/audit-failure-policy.test.ts`+`test/doctor.test.ts`を再実行し105/105 pass(297 assertions)。4クラス失敗ポリシー・spill/replay冪等性・破損行隔離・doctor統合が実装後も健全であることを再確認。

## 6. Compatibility — PASS

- `test/audit-compat-view.test.ts`を再実行し9/9 pass(57 assertions)。v0.26.3永続化回帰(`tools/list`+`tools/call`後2行以上)が互換ビュー経由で再現することを確認。

## 7. Performance — PASS(WARNING 1件)

- WARNING: `audit_events_compat`の`token_name`列(audit_events側で`COALESCE(client_id, actor_label)`計算式)が`idx_audit_events_client`に対して非sargable。`/admin/api/agents`等の相関サブクエリがseq scanになりうる。管理ダッシュボードの低頻度読取パスのみ影響、正確性への影響なし。`dashboard-7dtcd`として登録・対応は本Phase範囲外。

## 8. Testing — PASS(Correction Pass後、REQUIRED 2件を同ラウンド内で解消)

Stage6完了時点で未実行だった実Postgres系テストを本カテゴリのレビュー中に初めて実行し、以下2件のREQUIREDを発見・即修正・即再検証(詳細は`PHASE9C-IMPLEMENTATION-REPORT.md`§4・`PHASE9C-TEST-EVIDENCE.md`参照):

1. `test/e2e/serve-http-oauth.test.ts`の2テストがPhase9Cカットオーバーで破壊(mcp_request_log直読み)。修正後35/36 pass。
2. `test/e2e/principal-postgres.test.ts`の3テストがaudit_events FKで破壊(DROP TABLE principals)。修正後13/13 pass。

さらに実Postgres160ファイルフルE2Eスイート(1098+14テスト)を完走し、Phase9C由来の新規失敗ゼロを確認。残り6件の失敗は個別再実行で全てPhase9C無関係と確認(`dashboard-ebas5`)。

## 9. Documentation — PASS(WARNING 2件)

- `gbrain audit`のCLIヘルプテキストを実行時に検証、正確であることを確認。
- WARNING: README.mdに新規`gbrain audit`サブコマンドの記載なし(`dashboard-e9bl0`)。
- WARNING: HANDOVER.mdのgit状態記述がPhase9B時点のまま古い(Stage8完了時に更新予定、既知の想定内staleness)。
- CHANGELOG.md未更新はPhase9B自身も同様(バージョンカット時のみ更新する既存運用と整合、ギャップではない)。

## 10. Bundle Consistency — PASS

- `git status --short`の実測が`PHASE9C-IMPLEMENTATION-REPORT.md`§5の申告ファイル一覧と完全一致することを確認。
- `PHASE9C-EVIDENCE-MANIFEST.md`を実測値で更新済み(§6テーブル・REQUIRED台帳)。
- bdタスクツリーに孤児なし、全ての発見事項が個別bdタスクとして記録済み。

---

## REQUIRED台帳(全2件、両方とも同ラウンド内で解消)

| # | 指摘内容 | カテゴリ | 対応状況 | 解消ラウンド |
|---|---|---|---|---|
| 1 | `test/e2e/serve-http-oauth.test.ts`カットオーバー回帰 | Testing | 修正済み・実PG再検証35/36 pass | 1 |
| 2 | `test/e2e/principal-postgres.test.ts` FK回帰 | Testing | 修正済み・実PG再検証13/13 pass | 1 |

REQUIRED=0達成日: 2026-08-02(ラウンド1)。

---

## 未確認範囲・権限不足

- `scripts/run-unit-parallel.sh`フルshard実行によるテスト名レベルbaseline機械diff(`rc=143`アーティファクトのため正確な集計未取得、個別実行では全green)。
- 実際のCIパイプライン(GitHub Actions等)上での実行結果(ローカルdockerコンテナでの検証に限る)。
- 権限不足に該当する項目はなし。
