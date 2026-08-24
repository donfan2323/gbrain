# Phase 9C〜9E-1 — リリース準備監査

**日付**: 2026-08-03(2026-08-03追記: `dashboard-etlg2`でPhase 9C由来のcheck-test-isolation違反を修正、§4・§5更新)
**位置づけ**: 現在の未コミット作業ツリー(Phase 9C〜Phase 9E-2準備)を安全にコミット・本番反映するための実行計画。本書は計画のみであり、`git commit`・`git push`・本番デプロイ・DBマイグレーション実行は一切行っていない。
**関連**: `docs/PRODUCTION-DEPLOYMENT.md`(汎用デプロイ手順の正本、本書はこれを前提とし重複させない)、`PHASE9E1-PRODUCTION-DEPLOYMENT-PLAN.md`(本番反映手順・観察開始条件)。

---

## 1. 変更全体の棚卸し(実測)

- **base commit**: `fcdb7c47`(`feat(identity): Phase 9B Universal Identity Foundation - Principal基盤実装`)
- **本番デプロイ済みコミット**: `d2c9ae8d`(2026-07-29リリース) — **baseより4コミット古い**。`fcdb7c47`自体(Phase 9B)を含め、`6906ab99`/`d4f69dc0`/`1fa83d85`(デプロイパイプライン硬化3件)もまだ本番未反映。
- **tracked変更(M)**: 28ファイル
- **untracked変更(??)**: 36ファイル
- **総変更ファイル数**: 64ファイル(全て個別ファイル、ディレクトリ丸ごと未追跡のケースなし)
- **スキーマ移行ギャップ**: 本番はmigration v124、現dev treeはv128 —— **v125(Phase 9B)・v126-128(Phase 9C)の計4件が本番未適用**。Phase 9D・P0 narrowing・Phase 9E-1・Phase 9E-2準備はいずれもスキーマ変更なし(v128のまま)。

### 1-1. 分類結果(全64ファイル、区分不能ゼロ)

| 区分 | ファイル数 | 内訳 |
|---|---|---|
| Phase 9C由来 | 30 | 下記詳細参照 |
| Phase 9D由来 | 2(+2ファイル内の一部) | `PHASE9A-GAP-AND-ROADMAP.md`全体、`src/commands/serve-http.ts`・`test/authorization-invariant-matrix.test.ts`の一部(9Cと混在) |
| P0 narrowing(dashboard-5krlu)由来 | 4 | `test/operations-allow-list.test.ts`全体、`docs/architecture/KEY_FILES.md`全体、`src/core/operations.ts`の一部、`test/submit-agent.test.ts`の一部(9E-1と混在) |
| Phase 9E設計文書由来 | 3 | `PHASE9E-DELEGATION-DOMAIN-MODEL.md`、`PHASE9E-IMPLEMENTATION-SCOPE.md`、`PHASE9A-AUTHORIZATION-INVARIANTS.md` |
| Phase 9E-1実装由来 | 8 | 下記詳細参照 |
| Phase 9E-2準備機能由来 | 4 | `src/core/audit/delegation-scope-shortfall-report.ts`、`test/delegation-scope-shortfall-report.test.ts`、`test/audit-delegation-scope-shortfalls.test.ts`、`src/commands/audit.ts`の一部(9Cと混在) |
| 証跡・Review Bundleのみ | 3 | `PHASE9C-EVIDENCE-MANIFEST.md`・`PHASE9C-REVIEW-MANIFEST.md`・`PHASE9C-TEST-EVIDENCE.md` |
| 横断・複数フェーズ混在(文書) | 1 | `HANDOVER.md`(Phase 9C完了記録+Phase 9D節追加、生きたハンドオーバー文書のため単一フェーズに属さない) |
| CHANGELOG.md | 1 | P0/9E-1/9E-2準備の3セクションが混在(内容は既に区分別に段落分離済み) |
| コミット対象外にすべきもの | 0 | 該当ファイルなし(下記2-4参照) |

**注記(混在ファイルの扱い)**: `src/commands/serve-http.ts`(1244行追加)・`test/authorization-invariant-matrix.test.ts`(279行追加)・`src/core/operations.ts`・`test/submit-agent.test.ts`・`src/commands/audit.ts`の5ファイルは複数フェーズの変更が同一ファイル内に混在している。**リポジトリ履歴を改ざんしないrebase/squash/force pushは使わず**、`git add -p`(対話的部分ステージング)でハンクを分割してコミットすることを推奨する(下記§2で個別に明記)。

### 1-2. Phase 9C由来(30ファイル)

**コア実装**: `src/core/audit/audit-events-metrics.ts`・`audit-events-redact.ts`・`audit-events-spill.ts`・`audit-events-types.ts`・`audit-events-writer.ts`・`entrypoint-registry.ts`(6件、新規)、`src/commands/audit.ts`(新規、9E-2準備部分を除く)、`scripts/check-audit-registry-drift.sh`(新規)、`src/core/migrate.ts`・`src/core/oauth-provider.ts`・`src/cli.ts`(M、全体)、`src/core/pglite-schema.ts`・`src/core/schema-embedded.ts`・`src/schema.sql`(M、全体、migration v126-128)、`package.json`・`scripts/run-verify-parallel.sh`(M、check:audit-registry-drift登録)

**設計・証跡文書(コア)**: `PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md`・`PHASE9C-IMPLEMENTATION-SCOPE.md`・`PHASE9C-ACCEPTANCE-CRITERIA.md`・`PHASE9C-FAILURE-AND-DURABILITY-POLICY.md`・`PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md`・`PHASE9C-CURRENT-AUDIT-PATHS.md`・`PHASE9C-IMPLEMENTATION-REPORT.md`(7件、新規。コード内docstring・他文書から名指しで参照されているため必須、詳細は§3)

**テスト**: `test/audit-compat-view.test.ts`・`test/audit-delegation-chain.test.ts`(基盤部分、9E-1拡張分は§1-3参照)・`test/audit-entrypoint-coverage.test.ts`・`test/audit-event-foundation.test.ts`・`test/audit-event-generation.test.ts`・`test/audit-event-rollback-pglite.test.ts`・`test/audit-event-schema-parity.test.ts`・`test/audit-failure-policy.test.ts`・`test/audit-redaction.test.ts`・`test/e2e/audit-event-postgres.test.ts`(10件、新規)、`test/e2e/principal-postgres.test.ts`・`test/principal-rollback-pglite.test.ts`・`test/principal-schema-parity.test.ts`・`test/schema-bootstrap-coverage.test.ts`(M、Phase 9C新設FKがPhase 9Bロールバック手順に与える影響の追記)、`test/e2e/serve-http-oauth.test.ts`(M、`/mcp`のPhase 9Cカットオーバー部分)

**その他**: `PHASE9B-MIGRATION-AND-ROLLBACK.md`(M、Phase 9C導入に伴うv5訂正)

### 1-3. Phase 9E-1実装由来(8ファイル)

`src/core/delegation-capability.ts`(新規)、`src/commands/auth.ts`・`src/commands/doctor.ts`・`src/core/doctor-categories.ts`(M、全体)、`test/auth-register-client-args.test.ts`(M、全体)、`test/doctor-delegation-capability.test.ts`・`test/delegation-capability.test.ts`(新規)、`src/core/operations.ts`(M、一部 — Capability型リファクタ+AUTHZ-INV-017 warn-only部分。P0 narrowing部分とは別ハンク)、`test/submit-agent.test.ts`(M、193行純追加分)、`test/audit-delegation-chain.test.ts`(9E-1拡張分: `registerAgentClient`ヘルパー型拡張+6テスト)

---

## 2. コミット分割案(9境界、rebase/squash/force push不使用)

| # | コミット | 含めるファイル | 前提コミット | 単独revert | 対応Beads | 推奨コミットメッセージ | 本番反映 |
|---|---|---|---|---|---|---|---|
| 0 | (既存・新規作成不要) Phase 9B | `fcdb7c47`は既にコミット済み | base | 高 | `dashboard-vyyod`(CLOSED) | (変更なし、既存コミットをそのまま使う) | **必須**(migration v125) |
| 1 | Phase 9C Audit Event統合 | §1-2の全ファイル。`serve-http.ts`は`git add -p`で9C部分のみ抽出、`authorization-invariant-matrix.test.ts`も同様に9C側3 describe blockのみ | 0 | 高(新規テーブル・ビューのみ、既存列変更なし) | `dashboard-zz21x`(CLOSED、外部レビュー承認済み) | `feat(audit): Phase 9C Universal Audit Event Integration` | **必須**(migration v126-128、9E-1がaudit_events書込みに依存) |
| 2 | Phase 9D Policy Decision統一 | `serve-http.ts`の残りハンク(requireAdmin AUTHZ-INV-010部分)、`authorization-invariant-matrix.test.ts`の残り1 describe block、`PHASE9A-GAP-AND-ROADMAP.md` | 1(同一ファイル物理分割の都合上) | 高(スキーマ変更なし) | `dashboard-rn8t2`(CLOSED) | `fix(authz): AUTHZ-INV-010是正 - requireAdminをPolicy Decision経由に統一` | 推奨(挙動は不変と報告済みだが認可経路の変更) |
| 3 | P0 slug narrowing修正 | `src/core/operations.ts`の`isRequestedSlugPrefixWithinBound`+narrowing修正ハンク(`git add -p`)、`test/operations-allow-list.test.ts`全体、`test/submit-agent.test.ts`のdashboard-5krlu部分、`docs/architecture/KEY_FILES.md`、`CHANGELOG.md`のdashboard-5krlu段落 | 0(baseのみに依存、独立適用可能) | 高 | `dashboard-5krlu`(CLOSED) | `fix(security): submit_agent slug-prefix narrowingのfail-open修正` | **最優先で必須**(セキュリティ修正) |
| 4 | Phase 9E設計正本 | `PHASE9E-DELEGATION-DOMAIN-MODEL.md`・`PHASE9E-IMPLEMENTATION-SCOPE.md`・`PHASE9A-AUTHORIZATION-INVARIANTS.md` | 3 | 高(文書のみ) | `dashboard-qj0ir`(親、IN_PROGRESS) | `docs(phase9e): Delegationドメインモデル・実装スコープ確定` | 監査証跡のみ |
| 5 | Phase 9E-1 Capability・warn-only実装 | `src/core/delegation-capability.ts`、`operations.ts`の9E-1ハンク、`test/submit-agent.test.ts`の9E-1追加分、`test/audit-delegation-chain.test.ts`の9E-1拡張分、`test/delegation-capability.test.ts` | 1・3・4 | 中(operations.tsの分割精度に依存) | `dashboard-f5jd5`(CLOSED) | `feat(delegation): Phase 9E-1 Capability/DelegationConstraint型導入+AUTHZ-INV-017 warn-only` | **必須**(今回リリースの主目的) |
| 6 | Phase 9E-1 CLI・doctor対応 | `auth.ts`・`doctor.ts`・`doctor-categories.ts`・`test/auth-register-client-args.test.ts`・`test/doctor-delegation-capability.test.ts` | 5 | 高 | `dashboard-f5jd5`(継続) | `feat(delegation): CLI事故入力検出・doctor delegation_capability_health追加` | 推奨(運用可視性、機能上は5だけでも動く) |
| 7 | AUTHZ-INV-017移行対象集計CLI | `delegation-scope-shortfall-report.ts`、`audit.ts`の9E-2準備ハンク(`git add -p`)、`test/delegation-scope-shortfall-report.test.ts`・`test/audit-delegation-scope-shortfalls.test.ts` | 1・5 | 高 | `dashboard-v3mjk`(CLOSED) | `feat(audit): AUTHZ-INV-017 enforce移行対象集計CLI追加` | 推奨(9E-2判断材料、9E-1動作に必須ではない) |
| 8 | 文書・CHANGELOG仕上げ | `CHANGELOG.md`の残り(9E-1/9E-2準備段落)、`HANDOVER.md` | 1-7全て | 高 | — | `docs: Phase 9C-9E-1 CHANGELOG・HANDOVER更新` | 監査証跡のみ |

**適用順序の注記**: 上表の番号順が依存関係を満たす適用順。0→1→2→3→4→5→6→7→8。3(P0)は理論上0のみに依存し独立して先頭に置くことも可能だが、`operations.ts`の物理的なハンク分割の実務上、1・2より後に適用する方が競合が少ない。

---

## 3. リリース対象の確定

### 含める(git管理・本番リリース対象)

- §1-2・§1-3の全実装ファイル・テスト・**コア設計文書7件**(`PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md`等) — `src/commands/audit.ts`の docstringが`PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §6-4, §6-6`を名指しで参照し、`PHASE9B-MIGRATION-AND-ROLLBACK.md`が`PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md §6`を参照し、`HANDOVER.md`が`PHASE9C-IMPLEMENTATION-REPORT.md §5`を参照している——これらを含めないと文書間参照が宙に浮く。
- `PHASE9E-DELEGATION-DOMAIN-MODEL.md`・`PHASE9E-IMPLEMENTATION-SCOPE.md`・`PHASE9A-AUTHORIZATION-INVARIANTS.md`(正本)
- `CHANGELOG.md`・`HANDOVER.md`(運用記録として必須)

### 除外を検討する

- **`PHASE9C-EVIDENCE-MANIFEST.md`・`PHASE9C-REVIEW-MANIFEST.md`・`PHASE9C-TEST-EVIDENCE.md`**: 内容を確認したところ、それぞれ「証跡目録のプレースホルダー/チェックリスト」「Stage7内部敵対的レビューの判定記録」「型チェック・テスト実行の生ログ記録」であり、実装の一部ではなく**Phase 9Cの外部レビュープロセス自体の記録**。既存の`PHASE9C-*`文書群(Evidence/Review/Test-Evidenceの3点セット)は本プロジェクトの確立された慣行(このリリース準備監査自体もBeadsのnotesとして記録している)なので、リポジトリから完全に除外する必要はないが、**本番の`current`シンボリックリンク配下(実行に必要なコード)には不要**——`build-release.sh`の`git archive`はコミットされた全ファイルをそのまま含めるため、含めても実害はない(実行時に読み込まれない静的文書)。**結論: gitへのコミットは許容するが、必須ではない。含めるかどうかはユーザー判断。**
- Review Bundle ZIP・sidecar・`changed-files/`ディレクトリ: **今回の作業ツリーには存在しない**(`find`で確認済み、該当ファイルなし)。
- Beads内部ファイル(`dashboard/.beads/*.db`等): **gbrainリポジトリ内に一切存在しない**(AI_1プロジェクトの別リポジトリ`/Users/lab2/AI/AI_1/dashboard/.beads/`にのみ存在し、gbrainのgit管理対象外)。
- Ruflo記憶データ: 同様に**gbrainリポジトリ内に存在しない**。
- ローカルDB・バックアップ・`.env`: `git ls-files`で`.env`系のトラッキングなし(`.env.testing.example`のみ、`.gitignore`の`!.env.*.example`で明示許可されたテンプレート)。`.gbrain/`データディレクトリはリポジトリ外(`~/.gbrain`)。

### 一時ファイル・stash・worktreeの確認結果

- **stash**: なし。
- **worktree**: `git worktree list`で**4件の古いworktreeが残存**していることを確認した。いずれも別セッション(`21de68db-...`)のPhase 9B検証作業由来で、`/private/tmp/claude-501/.../scratchpad/`配下(`phase9b-baseline-worktree`・`phase9b-verify-worktree`・`v7-baseline`・`v7-patched`)。Phase 9Bは既にCLOSED・コミット済みのため、これらは**用済みのクリーンアップ対象**。今回は削除していない(明示依頼なしに`git worktree remove`等の破壊的操作は行わない方針)。**リリース作業に着手する前に、ユーザー確認の上で`git worktree remove`することを推奨**(該当ブランチ`phase9b-required-remediation-baseline`等も同様に整理対象)。
- **生成物**: `node_modules`・`dist`等のビルド生成物はリポジトリ外(`.gitignore`済み)、混入なし。

### secret scan結果

`git diff`全体(tracked)・全untracked新規ファイルに対し、APIキー・トークン・パスワード・秘密鍵パターンでスキャンを実施した。

**結果: クリーン。** 検出された「secret」「token」等の文字列は全てOAuth 2.1プロトコルのフィールド名・変数名(`client_secret`パラメータ名、`error_description`等)、またはリダクション機能自体をテストするための**意図的な合成フェイク値**(`test/audit-redaction.test.ts`内の`sk-abcdefghijklmnopqrstuvwx1234567890ABCD`等、redaction機能が正しく検出・マスクすることを検証するための架空データ)のみで、実際の秘密値は一切含まれていない。`.env`ファイルはリポジトリに追跡されていない(`.env.testing.example`のみ、テンプレートとして許可)。実際の秘密値そのものは本書に一切記載しない。

---

## 4. テスト・リリースゲート

| 区分 | 項目 | 結果 |
|---|---|---|
| **必須** | `bun run typecheck` | clean(0エラー、本ターンで再実行済み) |
| **必須** | Phase 9C〜9E-2準備の関連unitテスト(34ファイル、584テスト) | **2026-08-03、`dashboard-etlg2`検証で原因を断定的に特定**(推測で済ませていない)。34ファイル一括実行を2回再現し、同一の3件(`audit-delegation-scope-shortfalls.test.ts`・`doctor-behavioral.test.ts`・`doctor-delegation-capability.test.ts`)が両回とも失敗。フル出力を精査した結果、3件全てbun:testの診断メッセージ「a beforeEach/afterEach hook timed out for this test.」が出ており、原因は**フックのロジック不良ではなくhookタイムアウト**と確定した。`--max-concurrency=4`に下げても再現(解消せず)。3ファイルそれぞれを単独実行すると全て0 fail(13/13・18/18・23/23)。34ファイルを17+17の2分割で実行すると271+354件が0 failで通過。**結論**: 34個のPGLite使用ファイルを同一bunプロセスに同時投入した際のCPU/メモリ競合によるhookタイムアウトであり、機能退行ではない。`doctor-behavioral.test.ts`(今回のPhase 9C〜9E-2準備の変更を一切含まない既存ファイル)も同一の失敗を示すことが、コード起因ではなくバッチサイズ起因であることの直接証拠。CI環境の実際のテスト実行方式(本プロジェクトの`scripts/run-e2e.sh`はE2Eをこの理由で意図的に1ファイルずつ逐次実行する設計)に合わせた検証を推奨。 |
| **必須** | `check:all`(23スクリプト) | **21/23 pass(2026-08-03、`dashboard-etlg2`修正後に再測定・不変)**。`check-test-isolation`が検出する違反は2件→**1件**に減少した(`test/authorization-invariant-matrix.test.ts:622`のPhase 9C由来違反を`dashboard-etlg2`で修正——`brokenEngine`の生成をdescribeスコープの`beforeAll`へ移動し、テストの目的・アサーション・AUTHZ不変条件の意味は一切変更していない)。残る`test/put-page-remote-auto.test.ts`のR1違反はbase commit `fcdb7c47`と完全に同一(`git diff fcdb7c47`で確認済み)の真の既存debtであり今回は対象外。ただし`check-test-isolation`スクリプト自体は違反が1件でも残っていれば非ゼロ終了するため、**スクリプト単位のpass/fail数(21/23)自体は変化しない**——変化したのは違反の中身と件数。`check-test-real-names`(`test/autopilot-install.test.ts:111`、無関係)は今回未着手のため変化なし。 |
| **必須** | secret scan | 上記§3参照、クリーン |
| **推奨** | 実PostgreSQL E2E(`gbrain-postgres-1`) | 本セッション中に複数回実施済み、既知1件(`dashboard-8xpiz`、無関係な`postgres.js`ドライバのtext[]型キャストバグ)を除き全pass |
| **推奨** | PGLiteテスト全体(migration up含む) | 128migration適用を伴う各テストのbeforeAllで毎回確認済み(v122→v128まで一貫して成功) |
| **既存問題により完全PASS不能** | `check-test-real-names`・`check-test-isolation` | 上記参照。機能的な欠陥ではなくテスト衛生上のlint違反 |
| **本番停止後でなければ実施不能** | migration up/down の本番PGLiteデータへの実適用確認、本番HTTPサーバースモーク、OAuth認証・Audit Event書込み・`delegation_scope_shortfall`記録・集計CLI・doctorの本番環境での実行確認、ログ確認 | `PHASE9E1-PRODUCTION-DEPLOYMENT-PLAN.md`§手順参照 |
| **推奨(未実施)** | package/build(`scripts/release/build-release.sh`) | 今回は実行していない(git commit未実施のため`--allow-dirty`なしでは失敗する。commit後に実施すべき) |

**「全件PASS」とは言わない**: `check-test-isolation`は違反1件(`test/put-page-remote-auto.test.ts`、既存debt)が残るため`check:all`は引き続き21/23。`check-test-real-names`の1件も未着手。34ファイル一括実行時の3件はhookタイムアウトと原因を特定済みで新規退行ではないと判断する(推測ではなく診断メッセージ・単独実行結果・分割実行結果による確認)。

---

## 5. 本番反映をブロックするBeads

| Bead | 分類 | 理由 |
|---|---|---|
| `dashboard-z7a1o`(bound_source_id defaultフォールバック) | **Phase 9E-2前に必須** | AUTHZ-INV-005の既知未充足として9E-1が意図的に先送りした項目。9E-1自体の動作には影響しない(既存挙動のまま)ため今回のリリースはブロックしないが、9E-2(enforce化)の前提には含める必要がある |
| `dashboard-037qj`(budget強制の事実確認未了) | 監視のみ | 実装ではなく事実確認タスク。今回のリリース・9E-2判断のいずれもブロックしない(Capability/DelegationConstraint分離自体はbudgetの強制状況に依存しない設計) |
| `dashboard-1etlb`(correlation_id分裂) | 監視のみ(孫委任有効化前は要再評価) | `delegation.grant`行自体は自己一貫しており今回の集計CLIの精度に影響しない。ただしAUTHZ-INV-009(委任チェーン監査再構成)が孫委任で本格的に必要になる段階では要対応 |
| `dashboard-7nqk9`(audit_eventsサイズ上限未実装) | リリース後でも可 | `delegation_scope_shortfall`のparams_summaryは構造的に小さく(missing_scopes/shortfall_toolsのみ)本リスクの影響を受けない。Phase 9E非依存(Bead自身のタイトルが明記) |
| `dashboard-yug65`(job-owner key不一致) | 今回のリリースと無関係 | `minion-spend.ts`という別サブシステムのbug、Phase 9C-9E-1のいずれのコードパスにも関与しない |
| `dashboard-rx3ja`(check-test-real-names違反) | リリース後でも可 | `test/autopilot-install.test.ts`という完全に無関係なファイルのlint違反、機能欠陥ではない |
| `dashboard-ckcvs`(check-test-isolation違反、当初2件) | **Phase 9C由来分は解消済み**(`dashboard-etlg2`)。残る`test/put-page-remote-auto.test.ts`分は**リリース後でも可** | Phase 9C自身が導入した`test/authorization-invariant-matrix.test.ts:622`の違反は2026-08-03に修正済み(検証: 修正前後のRed/Green、5回反復実行で安定、`typecheck`/`check-test-isolation.sh`/`check:all`/関連回帰で確認)。残る`test/put-page-remote-auto.test.ts`はbase commitと同一の真の既存debtであり今回のスコープ外——`dashboard-ckcvs`はこの残存分の追跡用に維持する |
| `dashboard-8xpiz`(実PG revoke type castバグ) | リリース後でも可 | 本番はPGLite(このバグの影響を受けるドライバ経路とは無関係)。実Postgresトポロジ利用時のみ影響する既存debt |

---

## 6. 参照元

- `docs/PRODUCTION-DEPLOYMENT.md`(汎用デプロイ手順・PGLite排他制約の正本)
- `PHASE9E1-PRODUCTION-DEPLOYMENT-PLAN.md`(本番反映手順・ロールバック・AUTHZ-INV-017観察開始条件)
- `PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md`(Phase 9Cロールバック手順)
- `PHASE9B-MIGRATION-AND-ROLLBACK.md`(Phase 9Bロールバック手順、v5でPhase 9C依存関係を追記済み)
- Beads: `dashboard-qj0ir`(Phase 9E親)・`dashboard-fqotx`(本監査タスク)
