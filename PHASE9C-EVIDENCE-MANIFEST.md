# Phase 9C — 証跡目録(Evidence Manifest)

**日付**: 2026-08-02
**位置づけ**: 本書はStage3(設計文書作成)時点で作成する**プレースホルダー**である。本書執筆時点でPhase 9Cの実装は一切行われていない。したがって本書は「収集済みの証跡一覧」ではなく、「Stage5(実装)〜Stage8(Review Bundle作成)を通じて、各項目に実際のファイルパス・コマンド・実測結果を追記していくための目録(チェックリスト)」として運用する。存在しない実測値をあたかも取得済みであるかのように書かない(gbrainの開発ルール: 推測禁止・証跡主義)。本書自体もStage2(Opus設計)の`design`オブジェクト各フィールドとStage1(6エージェント並列調査)の`result.results`各`findings`に既に記録された内容を整理・体系化したものであり、新しい設計判断は行わない。

---

## 0. ステータスマーカーの凡例

本書全体を通じて、各証跡項目には以下のいずれかのマーカーを付す。

| マーカー | 意味 |
|---|---|
| **[確定済み]** | Stage3時点(本書執筆時点)で既に確認・決定済みの事実。ファイルシステム上の直接確認、または既存のStage2設計・Stage3姉妹文書の記載に基づく |
| **[未取得]** | 該当Stageの完了後に、実際の値・ファイルパス・生ログ・コマンド出力で置き換えられるべき項目。本書執筆時点では未取得 |
| **[未作成]** | 該当する証跡ファイル・スクリプト自体がStage3時点でまだ存在しない(Stage5以降で新設される想定) |

---

## 1. 前提: 2026-08-02付ユーザー確定事項

Stage2(Opus設計)の`open_questions_for_user`4件は、以下のとおりユーザーが2026-08-02に確定した。本書はこれを確定済み前提として各Stageの証跡項目に反映する(未決事項としては扱わない)。

- **(a) Phase 9B実装34ファイルは独立コミット済み(commit `fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。** [確定済み] 4章(Stage5)のdiff・変更ファイル一覧は、このコミットを起点(base)として取得する。Stage1調査時点(2026-08-02)ではworking treeに34件の未コミット変更(M14+??20、HEAD=`6906ab998201...`)が存在しコミットされていなかったが、この状態は解消済みである。
- **(b) `oauth_clients`のhard delete→soft delete統一は今回は実施しない(Opus提案どおり)。** [確定済み] `audit_events.client_id`はFKなしの非正規化列のままとする(`src/commands/auth.ts:315`のhard delete経路は変更しない)。5章(Stage6)の`test/audit-event-foundation.test.ts`実行結果には、`client_id`にFK制約が存在しないことを積極的な合格基準として検証した結果を記載する。
- **(c) `/admin/api/*`の読み取り専用GET 11ルートは監査対象外のまま(Opus提案どおり)。** [確定済み] 5章(Stage6)`test/audit-entrypoint-coverage.test.ts`の登録簿に、この11ルートを「意図的に監査しない経路」として明記した結果を記載する。
- **(d) `gbrain audit prune`の既定は自動削除なし(Opus提案どおり)。** [確定済み] 5章(Stage6)のテスト証跡に、期間指定なし・`--dry-run`なし実行でも監査行が削除されないことの実測結果を記載する。

---

## 2. Stage3時点で既に存在する証跡(設計文書6点)

Stage3は設計文書7点(本書含む)を並列作成する工程である(Beads `dashboard-zz21x`のNOTES「Stage3着手」に列挙: `PHASE9C-CURRENT-AUDIT-PATHS`/`AUDIT-EVENT-DOMAIN-MODEL`/`MIGRATION-AND-COMPATIBILITY-PLAN`/`FAILURE-AND-DURABILITY-POLICY`/`IMPLEMENTATION-SCOPE`/`ACCEPTANCE-CRITERIA`/`EVIDENCE-MANIFEST`)。以下は本書(`PHASE9C-EVIDENCE-MANIFEST.md`)を除く6点で、Stage1・Stage2の決定事項を体系化したものである。本書執筆時点(2026-08-02)でファイルシステムを直接確認(`find`/`ls`/`wc -l`)した結果は以下のとおり。

| # | ファイル | 内容 | 本書執筆時点の状態 |
|---|---|---|---|
| 1 | `PHASE9C-CURRENT-AUDIT-PATHS.md` | Stage1(6エージェント並列調査、key: A〜F)の結果を体系化した現状監査経路の一覧 | **[確定済み]** 353行、存在確認済み(2026-08-02、Stage3全7エージェント完了後に再確認。本書執筆時点では並列実行中でファイルが未生成だったため一時的に「未作成」と記載していたが、Stage3完了後の実測で解消) |
| 2 | `PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md` | Stage2 `design.domain_model`・`design.unattributed_state_model`を体系化した`audit_events`ドメインモデル(27列・11帰属状態) | **[確定済み]** 200行、存在確認済み |
| 3 | `PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md` | Stage2 `design.mcp_request_log_disposition`・`design.migration_and_schema_plan`・`design.backfill_migration_plan`を体系化したマイグレーション/互換性計画(v126〜v128) | **[確定済み]** 315行、存在確認済み |
| 4 | `PHASE9C-FAILURE-AND-DURABILITY-POLICY.md` | Stage2 `design.failure_policy`・`design.jsonl_disposition`(durable spill部分)を体系化した失敗ポリシー(クラス1〜4) | **[確定済み]** 190行、存在確認済み |
| 5 | `PHASE9C-IMPLEMENTATION-SCOPE.md` | Stage2 `design.scope_boundary`・`design.non_goals`を体系化した実装スコープ(IN 6経路・OUT 4種別) | **[確定済み]** 174行、存在確認済み |
| 6 | `PHASE9C-ACCEPTANCE-CRITERIA.md` | Stage2 `design.test_strategy`を体系化した受入基準・テストファイル一覧(11ファイル) | **[確定済み]** 131行、存在確認済み |

**関連するが上記6点に含まれない既存文書**: `PHASE9C-PREREQUISITES.md`(2026-08-02 06:32作成、Stage1着手前にPhase 9B内部レビューの知見を整理した前提文書。Beads NOTESが列挙するStage3の7点には含まれない)。

**Stage4着手前の確認事項**: 上記表は解消済み(2026-08-02、全7ファイルの存在・行数を実測確認済み)。「未作成」項目は残っていない。

---

## 3. Stage4で収集すべき証跡(各専門Reviewerの設計レビュー結果)

Stage4は、2章の設計文書6点(および対象範囲確定後は本書を含める可能性がある)に対する設計レビューである。`PHASE9C-ACCEPTANCE-CRITERIA.md`§5が定める7専門領域(Architecture/Security-Privacy/Database-Migration/Reliability-Durability/Compatibility/Performance/Testing)を用いる。この運用自体はPhase 9B(`PHASE9B-REVIEW-MANIFEST.md`)のReview Bundle方式(複数ラウンド)と同一のREQUIRED=0判定ロジックを踏襲するが、Reviewer構成(専門領域の内訳)はPhase 9Bの7領域とは異なるPhase 9C独自の7領域である。

**注記(本書更新時点、2026-08-02)**: 以下はStage4完了後にBeadsタスク`dashboard-zz21x`のnotes欄(圧縮前セッションで各ラウンド完了直後に記録)から再構成した実測記録である。REQUIRED総数はラウンドごとに正確に記録されているが、カテゴリ別のPASS/WARNING内訳は数値としては記録されておらず(質的な指摘内容のみ記録)、この粒度は**未確認範囲**として明記する(捏造しない)。

| ラウンド | 総REQUIRED件数 | カテゴリ別REQUIRED内訳(判明分) | 備考 |
|---|---|---|---|
| 1 | 19 | Architecture2 / Security-Privacy4 / Database-Migration1 / Reliability-Durability4 / Compatibility5 / Performance1 / Testing2 | 初回レビュー |
| 2(Correction Pass1後) | 14 | Architecture3 / Security2 / Reliability2 / Compatibility2 / Performance2 / Testing3(Database-Migration0到達) | |
| 3(Correction Pass2後) | 10 | Architecture1 / Security1 / Reliability2 / Compatibility2 / Performance1 / Testing3(DB-Migration継続0) | |
| 4(Correction Pass3後) | 10 | Architecture2 / Security2 / Database1(新規) / Performance1 / Testing4(Reliability・Compatibility0到達) | 横ばいだが内訳変化 |
| 5(Correction Pass4後) | 17 | 伝播バグ5件(route数10/11の同一原因)+実質的設計指摘8件+その他 | 深化(一時増加)。伝播バグ5件は直接Edit即時修正 |
| 6(Correction Pass5後) | 9 | 実質的指摘9件(admin session確立2経路のscope欠落・redaction汎用パターン欠如等) | ユーザー指示により以降Correction Passはソロ処理へ切替 |
| 7(Correction Pass6後、最終) | **0** | — | 5文書再読によるセルフ検証で新規矛盾なしを確認 |

- **REQUIRED台帳**: 全19件(初出時点の累計識別数、Round1〜6で段階的に解消)の一覧は`dashboard-zz21x`のnotes欄に質的記述として残るが、本書時点で構造化された表形式の再収録は行っていない(**未確認範囲・理由: 圧縮前セッションの記録が自由記述形式であり、機械的な表への変換は本再提出の必須項目としなかった**。承認への影響: REQUIRED総数と収束経過そのものは上記表で確認可能なため、これによりREQUIRED=0の事実自体は揺るがないと判断)。
- **REQUIRED=0達成日**: 2026-08-02(Round7、Correction Pass 6回を経て収束)。
- **Correction Pass→再提出の履歴**: 収束経過は 19→14→10→10→17(深化)→9→0 の7ラウンド、Correction Pass回数6回。Round5でのみ一時増加が発生した理由は、Round4までの修正がroute数(10/11/18)の伝播不整合を生み、Round5レビューでその伝播が複数カテゴリにまたがって検出されたため(直接Editで即時修正、Round6は実質的設計指摘のみに収斂)。

---

## 4. Stage5で収集すべき証跡(実装差分)

| 項目 | 内容 |
|---|---|
| 起点コミット(base) | `fcdb7c47d34696a1cb23fb79e878978dc0c23186`(1章(a)、確定済み) **[確定済み]** |
| 実装完了コミット | 未コミット(working tree、ユーザー承認・外部レビュー承認まで意図的にコミットを見送っている、Phase 9Bと同一方針)。`git status --short`実測: tracked modified 20件・untracked 28件・合計48件(2026-08-02再取得、生成コマンド・生ログは`reports/file-count-ledger.txt`・`git-status.txt`参照) **[確定済み]** |
| 変更ファイル一覧 | 48件(新規28+変更20)。完全な一覧は`PHASE9C-IMPLEMENTATION-REPORT.md`§5、機械生成台帳は本Bundleの`reports/file-count-ledger.txt`を参照 **[確定済み]** |
| 差分(diff、read-only Git差分) | `phase9c-code-changes-v2.diff`(`git add -A && git diff --cached && git reset`方式で生成、新規未追跡ファイルの完全な追加内容を含む。適用検証: クリーンな一時worktreeへ適用し全48ファイルの再現をbyte-diffで確認済み、`reports/patch-apply-log.txt`参照) **[確定済み]** |
| 新規追加ファイル一覧 | 28件。`src/core/audit/`配下6ファイル(Writer/redaction/spill/types/metrics/entrypoint-registry)、`src/commands/audit.ts`(CLIサブコマンド`replay-spill`/`prune`/`status`)、`scripts/check-audit-registry-drift.sh`、`test/audit-*.test.ts`9本、`test/e2e/audit-event-postgres.test.ts`、`PHASE9C-*.md`設計文書・証跡文書10本。詳細は`PHASE9C-IMPLEMENTATION-REPORT.md`§5-1 **[確定済み]** |

### 4-1. マイグレーション適用ログ

`PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md`が設計するv126〜v128(現行`LATEST_VERSION`=125からの追加分)の適用ログ。

| バージョン | 内容(設計上の予定) | PGLite適用ログ | Postgres適用ログ |
|---|---|---|---|
| v126 | audit_event_foundation(登録表3つ`audit_event_kinds`/`audit_channels`/`audit_attribution_states`+`audit_events`本体+インデックス7本+RLS) | `[126] ✓ audit_event_foundation`(`test/audit-event-foundation.test.ts`等で反復実行確認) **[確定済み]** | `[126] ✓ audit_event_foundation`(実PG docker `gbrain-postgres-1`、新規インストール123 migration適用時・v124→v128アップグレード時の両方で確認) **[確定済み]** |
| v127 | audit_events_compat_view(`audit_events_compat`ビュー+`audit_events_attribution_gaps`ビュー) | `[127] ✓ audit_events_compat_view` **[確定済み]** | `[127] ✓ audit_events_compat_view`(実PG、`security_invoker=on`含め確認) **[確定済み]** |
| v128 | rls_principal_tables(`principals`/`principal_kinds`のRLS有効化、`dashboard-m1ja3`解消) | `[128] ✓ rls_principal_tables`(PGLite側はsqlFor.pglite=''によりRLS DDL自体スキップ、設計どおり) **[確定済み]** | `[128] ✓ rls_principal_tables`(実PG、`pg_class.relrowsecurity=true`をaudit_events含む6表で実測確認、`test/e2e/audit-event-postgres.test.ts`) **[確定済み]** |

- `apply-migrations`実行の生ログ: 本Bundleの`test-logs/`配下、各テスト実行ログ内に`initSchema()`呼び出し時のマイグレーション適用トレース(`[126] audit_event_foundation...`形式)として記録されている。専用の単独ログファイルは別途作成していない(**未確認範囲**: `gbrain apply-migrations` CLIコマンド単体での実行ログは未取得。承認への影響: `initSchema()`経由の適用ログで同一のマイグレーションコードパスが実行されることを確認済みであり、CLI経由か否かで適用内容自体に差異はないため軽微と判断)。
- `applyForwardReferenceBootstrap`への追加要否: **不要と確定**。`test/schema-bootstrap-coverage.test.ts`のdrift検証(9 tests)が実装後も引き続きgreenであることを確認済み(本Bundle`test-logs/`参照)。設計方針どおり、Phase 9Cの新規オブジェクトは`schema.sql`のprincipalブロックより後に配置されており前方参照が発生しないため、追加不要という判断が実測で裏付けられた。
- `verifySchema()`実行後の`audit_events.principal_id`FK実在確認(`dashboard-r3be4`対処確認): `test/e2e/audit-event-postgres.test.ts`のRLS/インデックス検証テストおよび`test/audit-event-foundation.test.ts`のFK enforcement検証テストで、`audit_events.principal_id → principals(id) ON DELETE RESTRICT`が実PG・PGLite双方で実在し機能することを確認済み **[確定済み]**。

---

## 5. Stage6で収集すべき証跡(テスト実行ログ・baseline・rollback・静的チェック)

### 5-1. `PHASE9C-ACCEPTANCE-CRITERIA.md`§3列挙のテストファイル実行生ログ

| # | ファイル | 種別 | 実行結果 |
|---|---|---|---|
| 1 | `test/audit-event-foundation.test.ts` | 新規・PGLite単体 | 20 pass / 0 fail **[確定済み]** |
| 2 | `test/e2e/audit-event-postgres.test.ts` | 新規・実Postgres E2E(`DATABASE_URL`未設定時skip) | 6 pass / 0 fail / 54 expect() calls(実PG docker `gbrain-postgres-1`で実行) **[確定済み]** |
| 3 | `test/audit-event-schema-parity.test.ts` | 新規・fresh/migrated schema parity検証(列・型・NOT NULL・既定値・CHECK・FK・インデックス) | 1 pass(32 assertions) **[確定済み]** |
| 4 | `test/audit-event-rollback-pglite.test.ts` | 新規・rollback実行検証+自己復元欠陥の回帰確認 | 5 pass / 0 fail **[確定済み]** |
| 5 | `test/authorization-invariant-matrix.test.ts`(既存拡張) | 拡張・grep静的検証+パラメタライズド不変条件検証 | 56 pass / 0 fail **[確定済み]** |
| 6 | `test/audit-failure-policy.test.ts` | 新規・失敗注入(クラス1〜3) | 20 pass / 0 fail **[確定済み]** |
| 7 | `test/audit-redaction.test.ts` | 新規・テーブル駆動/property的redaction検証 | 32 pass / 0 fail **[確定済み]** |
| 8 | `test/audit-delegation-chain.test.ts` | 新規・委任チェーン結合テスト(AUTHZ-INV-009) | 8 pass / 0 fail **[確定済み]** |
| 9 | `test/audit-compat-view.test.ts` | 新規・互換ビュー検証(v0.26.3永続化回帰の再現含む) | 9 pass / 0 fail / 57 expect() calls **[確定済み]** |
| 10 | `test/audit-entrypoint-coverage.test.ts` | 新規・登録簿drift検証(AUTHZ-INV-013) | 13 pass / 0 fail **[確定済み]** |
| 11 | `test/audit-event-generation.test.ts` | 新規・IN対象6経路の正常運行時(故障注入なし)行生成直接検証(AUTHZ-INV-013) | 14 pass / 0 fail(実HTTPサーバ、実PG) **[確定済み]** |
| 条件付き | `test/schema-bootstrap-coverage.test.ts`へのエントリ追加 | 既存ファイル拡張(前方参照新設時のみ) | **不要と確定**。drift検証green・追加なし。テスト自体はDROP順序修正(下記§実装報告書参照)を適用しgreen |
| 条件付き | `test/e2e/postgres-bootstrap.test.ts`へのエントリ追加 | 既存ファイル拡張(前方参照新設時のみ) | **不要と確定**。同上の理由(前方参照が発生していないため) |

静的チェック1本(`scripts/check-audit-registry-drift.sh`)を含め、全12項目がgreen。生ログは本Bundle`test-logs/`配下。

### 5-2. baseline機械diff結果

- 比較方式: `PHASE9C-ACCEPTANCE-CRITERIA.md`§4が指定する、生ログから`(fail)`行をテスト名単位で機械抽出しdiffする方式(`extract_fails.py`/`diff_fails.py`型)。shard単位のpass/fail件数の目視突合は禁止。
- 事前宣言済みの既知baseline失敗(2ファイル、個別失敗テストケースは計3件。Stage1 key:E `tests-evidence`が2026-08-02に`bun test`実行で直接確認済み、Phase 9B/9Cいずれのソース変更にも起因しない): **[確定済み]**
  - `test/core/retry.test.ts` — 1件失敗。`BATCH_AUDIT_SITES`期待値のSetに`mcp.put_page.remote_auto`が欠落(`src/core/retry.ts:94`には定義済み)。Beads `dashboard-2vepx`。実行結果: 36 pass / 1 fail / 194 expect() calls。
  - `test/scripts/run-unit-parallel.test.ts` — 2件失敗(`exits zero when all shards pass`・`clears .context/test-failures.log to empty when all shards pass`、`run-unit-parallel.sh`ラッパー自己テスト)。Beads `dashboard-nc8tl`。実行結果: 4 pass / 2 fail / 13 expect() calls。
- Phase 9C baseline(patched側)取得結果: 本再提出(v2)で、base commit(`fcdb7c47`)とPhase 9C適用後(patched)の2つの独立worktreeを用意し、typecheck・全check:*スクリプト個別実行(rc=143アーティファクト回避のため並列ラッパーを介さず単体実行)・**fast unit test files 1030件全件**(`test/e2e/*`・`*.slow.test.ts`・`*.serial.test.ts`を除く範囲、非shard・単一プロセス)・release buildを同一コマンド・同一環境でbase/patched両方に実行。**`scripts/run-serial-tests.sh`のbase/patched両完走は本ラウンドの時間内に完了できておらず、この一覧には含まれない**(未実施の理由・残リスクは`COMPLETION-REPORT.md`の「Known constraints」参照)。結果は本Bundle`test-logs/base/`・`test-logs/patched/`、機械比較結果は`reports/regression-diff.txt`を参照(生成過程は`COMPLETION-REPORT.md`に記載)。
- Phase 9C由来の新規失敗の有無: `reports/regression-diff.txt`のとおり(詳細は同ファイル参照。本欄はサマリのみとし、生成物を単一の真実源とする)。
- 実PostgreSQL 160ファイルフルE2Eスイート(`scripts/run-e2e.sh`)は、Stage7実施時点でpatched側のみ完走済み(1098 pass/14 fail、全14件を個別triaged)。**base側での同一E2E実行・base/patched比較は本v2ラウンドでも実施していない**(未実施の理由・残リスクは`COMPLETION-REPORT.md`の「Known constraints」参照)。詳細は`test-logs/e2e-patched/`。

### 5-3. rollback実行ログ

- ロールバックSQL(`DROP VIEW audit_events_compat`・`DROP VIEW audit_events_attribution_gaps` → `DROP TABLE audit_events` → `DROP TABLE`登録表3つ`audit_event_kinds`/`audit_channels`/`audit_attribution_states`)の実行結果: PGLite・実Postgres双方で実行検証済み。PGLite: `test/audit-event-rollback-pglite.test.ts`(`.exec()`によるBEGIN/COMMIT付き複数文実行)。実Postgres: `test/e2e/audit-event-postgres.test.ts`最終テスト(`sql.begin(async tx => {...})`経由)。両方とも`config.version`巻き戻し・全Phase9Cオブジェクトの消失(カタログ照会+実クエリ)を確認 **[確定済み]**。
- 実行順序の警告の遵守確認: `test/audit-event-rollback-pglite.test.ts`の最終テストが、コード(migrations定義)がv128対応のままSQLロールバックのみを実行した場合に`initSchema()`再実行で自己復元することを意図的に再現・pin済み(§6-1の教訓をテストとして固定)。
- 自己復元欠陥の回帰テスト結果: PASS(意図した挙動として固定、`test/audit-event-rollback-pglite.test.ts`内「§6-1自己復元欠陥」テストケース)。
- ロールバック後の`mcp_request_log`無傷確認: PGLite・実Postgres双方で、ロールバック前に挿入した`mcp_request_log`行がロールバック後も内容そのまま(`token_name`/`agent_name`/`operation`/`status`)残存することを実測確認済み **[確定済み]**。

### 5-4. 静的チェックスクリプトの実行結果

| スクリプト | 内容 | 本書執筆時点の状態 | 実行結果(exit code) |
|---|---|---|---|
| `scripts/check-search-path.sh` | 既存(Phase 9Bから継続使用) | **[確定済み]** 存在確認済み | 0(patched worktree実行、`test-logs/patched/checks-summary.txt`参照) |
| `scripts/check-jsonb-pattern.sh` | 既存(Phase 9Bから継続使用) | **[確定済み]** 存在確認済み | 0(同上) |
| `scripts/check-admin-scope-drift.sh` | 既存(Phase 9Bから継続使用) | **[確定済み]** 存在確認済み | 0(同上) |
| `scripts/check-audit-registry-drift.sh` | 新設(`PHASE9C-ACCEPTANCE-CRITERIA.md`§6)。TS側イベント種別/チャネル/帰属状態union型とDB側3登録表シード行の一致を検証。終了コード規約は`check-admin-scope-drift.sh`と同一(0=一致、1=drift検出、2=内部エラー) | **[確定済み]** Stage5で新設完了 | 0(patched worktree実行。base worktreeにはスクリプト自体が存在しないため対象外、`test-logs/base/checks-summary.txt`にN/A明記) |

- `bun run verify` / `bun run check:all`への配線確認結果: `package.json`の`check:audit-registry-drift`スクリプトエントリ、`scripts/run-verify-parallel.sh`のCHECKS配列、`package.json`の`check:all`チェーンいずれにも配線済みであることをソース確認済み **[確定済み]**。

---

## 6. Stage7で収集すべき証跡(内部敵対的レビュー)

対象10カテゴリ: Architecture / Security-Privacy / Database / Migration / Reliability-Durability / Compatibility / Performance / Testing / Documentation / Bundle Consistency。

| ラウンド | Reviewer | PASS | WARNING | REQUIRED |
|---|---|---|---|---|
| 1 | Architecture | PASS | 0 | 0 |
| 1 | Security-Privacy | PASS | 1(freeform-prose password残存限界、既知・test#7で明記済み) | 0 |
| 1 | Database | PASS | 0 | 0 |
| 1 | Migration | PASS | 0 | 0 |
| 1 | Reliability-Durability | PASS | 0 | 0 |
| 1 | Compatibility | PASS | 0 | 0 |
| 1 | Performance | PASS | 1(`dashboard-7dtcd`) | 0 |
| 1 | Testing | PASS(Correction Pass後) | 0 | 2(発見時。同ラウンド内で即修正・解消) |
| 1 | Documentation | PASS | 2(`dashboard-e9bl0`、HANDOVER.md git状態欄はStage8で更新予定) | 0 |
| 1 | Bundle Consistency | PASS | 0 | 0 |

Stage7はソロ実施(ユーザー指示「並列なしでメインのみで」により、Stage4のような専門Reviewerエージェント並列ではなく本体が直接10カテゴリを順次検証)。Testingカテゴリの検証中、本セッションで初めて実Postgres(docker `gbrain-postgres-1`, `localhost:5434/gbrain_test`)へアクセス可能になったため、これまでPGLiteのみでしか検証できていなかった経路を実行し、以下2件のREQUIRED(いずれもStage6完了時点では検出不能だった、実PG必須の回帰)を発見・即時修正・再検証済み:

### REQUIRED台帳

| # | 指摘内容 | 起票Reviewer | 対応状況 | 解消ラウンド |
|---|---|---|---|---|
| 1 | `test/e2e/serve-http-oauth.test.ts`の2テスト(v0.26.3永続化回帰・agent_name解決)がmcp_request_logを直接SELECTしており、Phase 9Cカットオーバー後(新規INSERT0件)に0行で失敗。`PHASE9C-ACCEPTANCE-CRITERIA.md`§3が事前宣言していた更新計画どおり、`audit_events_compat`参照へ書き換え。 | Testing(本体ソロ) | 修正済み・実PG再検証35/36 pass(残り1件は`dashboard-8xpiz`、Phase 9C無関係の既存`sql.array()`ドライバ互換性問題) | 1(bd `dashboard-blgxx`、同ラウンド内解消) |
| 2 | `test/e2e/principal-postgres.test.ts`の3テストが`DROP TABLE principals`を実行しており、Phase 9Cの`audit_events.principal_id`FK(RESTRICT・CASCADE無し)により`2BP01`で失敗。`PHASE9B-MIGRATION-AND-ROLLBACK.md`§4-1のv5追記(既に文書化済みの前提条件)どおり、各テストにPhase 9Cオブジェクト(ビュー2点+`audit_events`)の事前DROPを追加。 | Testing(本体ソロ) | 修正済み・実PG再検証13/13 pass | 1(bd `dashboard-k26fo`、同ラウンド内解消) |

- REQUIRED=0達成日: 2026-08-02(ラウンド1、Correction Pass込みで同日中に収束。Stage4のような複数ラウンドの往復は発生せず)。
- Correction Pass回数: 1(Testingカテゴリ内で2件発見・即修正・即再検証。他9カテゴリはCorrection Pass不要でPASS)。
- `PHASE9C-ACCEPTANCE-CRITERIA.md`§1〜§4の各合格基準に対する独立判定結果: §1(AUTHZ-INV-009/013)はTesting+Compatibilityカテゴリで実行時証跡により確認・PASS。§2(AUTHZ-INV-001/004)はArchitecture+Security-Privacyカテゴリで構造的証跡(grep静的検証+ランタイム証跡)により確認・PASS。§3(テストファイル一覧)は全11ファイル+静的チェック1本の実在・green化をTestingカテゴリで確認・PASS(`test/e2e/audit-event-postgres.test.ts`は実PGに対して実行され6/6 pass・54 expect()calls)。§4(baseline運用)はv2再提出ラウンドで**fast unit test files 1030件の範囲について**解消(下記参照。`run-serial-tests.sh`base/patched両完走・実PG E2Eのbase側実行は本ラウンドでも未実施であり、この解消はunitスコープに限定される)。
- **v2再提出ラウンドで解消(unitテスト1030件スコープ)**: `scripts/run-unit-parallel.sh`の`rc=143`アーティファクトは、個別チェック・個別テストファイルの生ログでは元々全green確認済みだった。v2再提出時、base commit(`fcdb7c47`)とpatched(現working tree)の2つの独立worktreeで、**fast unit test files 1030件全件**(`test/e2e/*`・`*.slow.test.ts`・`*.serial.test.ts`を除く範囲)を8チャンク(環境の非決定的なバックグラウンドタスク中断への対処として一部さらに半分・四半分へ分割)経由でbase/patched両方に対して実行し、テスト名レベルで機械比較した。結果: base=14,127 pass/6 fail、patched=14,256 pass/6 fail(差分はPhase 9C新規9ファイル分のテスト数)。6件の失敗は全てbase側にも同一内容で存在する既存の無関係な問題(退行なし)。Phase 9C由来の新規失敗は1件発見(`src/commands/audit.ts`のprocess.exitCode直接代入、setCliExitVerdict()未使用)、即修正・即再検証(bd `dashboard-cc5pj`、closed)。詳細は`reports/regression-diff.txt`。**この解消はunitテスト1030件の範囲に限定され、`run-serial-tests.sh`のbase/patched両完走・実PG E2Eのbase側比較・GitHub Actions実行には及ばない**(未実施の理由・残リスクは`COMPLETION-REPORT.md`の「Known constraints」参照)。
- 追加証跡: `scripts/run-e2e.sh`(実PG、160ファイル・1098+14テスト)をStage6完了後に初めて完走させた。REQUIRED2件(上記)を除く残り6件の失敗は、個別ファイル単独再実行で全て「Phase 9C差分と無関係」と確認済み(真のバグ4件+160ファイル一括実行時のみのfalse positive2件、詳細はbd `dashboard-ebas5`)。Phase 9C由来のE2E新規失敗は0件。

---

## 7. Stage8で収集すべき証跡(Review Bundle ZIP構成)

Phase 9BのReview Bundle構成(`PHASE9B-*.md`一式)を踏襲する。Phase 9Bで実際に採用された構成ファイルは以下のとおり(本書執筆時点でリポジトリ直下に実在確認済み)。

| Phase 9B相当ファイル | 役割 | Phase 9C相当 | 状態 |
|---|---|---|---|
| `PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md` | 実装スコープ提案 | `PHASE9C-IMPLEMENTATION-SCOPE.md`(2章#5) | **[確定済み]** Stage3で作成済み |
| `PHASE9B-IMPLEMENTATION-REPORT.md` | 実装レポート | `PHASE9C-IMPLEMENTATION-REPORT.md` | **[確定済み]** Stage8で作成完了(18622 bytes) |
| `PHASE9B-MIGRATION-AND-ROLLBACK.md` | マイグレーション/ロールバック手順書 | `PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md`(2章#3、設計部分)+ロールバック実行結果 | **[確定済み]** 設計部分はStage3作成済み、実行結果は本書§5-3(Stage6)へ追記済み |
| `PHASE9B-TEST-EVIDENCE.md` | テスト証跡 | `PHASE9C-TEST-EVIDENCE.md` | **[確定済み]** Stage8で作成完了 |
| `PHASE9B-REVIEW-MANIFEST.md` | レビューマニフェスト(専門Reviewer結果集約) | `PHASE9C-REVIEW-MANIFEST.md` | **[確定済み]** Stage8で作成完了。**注記: Stage7(内部敵対的レビュー10カテゴリ)はユーザー指示「並列なしでメインのみで」により本体Sonnetがソロで実施したものであり、独立した複数Reviewerエージェントによる並列レビューではない。この事実は`PHASE9C-REVIEW-MANIFEST.md`冒頭に明記済み** |

- **ZIP同梱範囲(確定)**: 設計文書6点(`CURRENT-AUDIT-PATHS`/`AUDIT-EVENT-DOMAIN-MODEL`/`MIGRATION-AND-COMPATIBILITY-PLAN`/`FAILURE-AND-DURABILITY-POLICY`/`IMPLEMENTATION-SCOPE`/`ACCEPTANCE-CRITERIA`)+本書(`EVIDENCE-MANIFEST`最終版)+`PREREQUISITES.md`+Stage8新規3文書(`IMPLEMENTATION-REPORT`/`TEST-EVIDENCE`/`REVIEW-MANIFEST`)+`changed-files/`(48ファイル完全体)+完全patch(`phase9c-code-changes-v2.diff`)+base/patched比較を含む生ログ一式+credential scan+bundle整合性証跡+HANDOVER.md+Beadsタスク情報。v1からの追加: 変更実ファイル本体・完全patch・base/patched比較ログ・reviewer原文記録・secret scan・ZIP自己検証情報。
- **ZIP構成一覧(実際のファイルツリー)**: 本Bundle自身の`bundle-integrity.txt`に`unzip -l`の実出力として収録(自己参照的検証、最終ビルド後に確定)。
- **ZIP作成コマンド・作成日時・ハッシュ**: `bundle-integrity.txt`にSHA-256含め収録(最終ビルド後に確定)。
- Phase 9B側のZIP自体の構成一覧(参照元)を独立に確認したかどうか: 本書はPhase 9B相当ファイル群がリポジトリ直下に存在することを確認したのみで、実際に配布されたZIPアーカイブそのものの内容一覧までは確認していない(**未確認範囲**、承認への影響は軽微 — Phase 9C自身のZIP構成はv2で自己検証済みのため)。

---

## 8. 本書の更新運用

- 本書は固定文書ではなく、Stage4〜Stage8の進行に伴い**追記・更新**されるチェックリストである。
- 各Stage完了時に、該当セクションの `[未取得]` マーカーを実際の値(ファイルパス・コマンド・実測結果)に置き換える。
- `[未作成]` のファイル・スクリプトがStage5以降で新設された場合、実際のパス・行数を本書に反映する。
- Stage8完了時点で本書に `[未取得]` が残っている場合、それはReview Bundleが未完成であることを意味し、外部レビュー提出前に解消すること。
