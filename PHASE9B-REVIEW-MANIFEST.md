# Phase 9B — 自己レビュー(Sonnet実施)

**日付**: 2026-08-01(初版) / 2026-08-01(v2、外部敵対的レビューREQUIRED-1〜7対応後の再自己レビュー) / 2026-08-02(v5、内部並列レビュー(7専門Reviewer)による補完注記)
**レビュー方式**: 実装担当(Sonnet)自身による自己レビュー。ユーザー指定のチェック項目12点全てについて、根拠となるgrep/テスト結果を示しながら判定する。**これは外部レビューの代替ではない。** ユーザーの明示的なレビュー完了までPhase 9Bは正式完了としない。

**v2改訂**: 初版提出は外部敵対的レビューで「未承認・REQUIRED 7件」と判定された。§13(新設)にREQUIRED-1〜7全件への対応状況を追記した。既存の12項目チェック(§1〜§12)は、v2で追加した実装(`isUndefinedTableError`のnarrowing、`applyForwardReferenceBootstrap`拡張)についても同じ基準で再確認し、結果を項目2・3・12に反映した。

---

## チェック項目

### 1. Phase 9のopen-world方針に反していないか

**判定: 反していない。** Principal種別は`principal_kinds`という登録テーブル方式で実装し、固定CHECK制約を採用しなかった(`PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1aのA/B/C/D比較でC案を確定)。実機テストで`INSERT INTO principal_kinds (id, label, description) VALUES ('robot', 'Robot', ...)`のみで新種別'robot'が追加でき、スキーマ変更を一切要しないことを確認済み(`test/principal-identity-foundation.test.ts`の該当テスト)。

### 2. 固定製品分岐を追加していないか

**判定: 追加していない。** `git diff HEAD -- src/core/operations.ts src/core/oauth-provider.ts | grep -iE "claude|chatgpt|gemini|anthropic|openai|grok|hermes|codex|perplexity"`は0件。**v2再確認**: v2で新たに変更した`src/core/pglite-engine.ts`・`src/core/postgres-engine.ts`・`src/core/utils.ts`・`src/core/oauth-provider.ts`(narrowing追加分)を同一grepで再検証し、同じく0件を確認した。

### 3. Principal種別を認可に利用していないか

**判定: 利用していない。** `grep -n "principalKind|principalId|kind_id" src/core/scope.ts`は0件——スコープ判定コア(`hasScope`)はPrincipal概念を一切参照しない。加えて`test/principal-identity-foundation.test.ts`の「異なるPrincipal種別・同一scope→同一認可結果」テストで、human/agent/unknown種別のクライアントが全て同一のread許可・admin拒否という結果になることを実測確認済み。**v2で追加**: `test/authorization-invariant-matrix.test.ts`でPrincipal状態8種(null/human/service/agent/device/unknown/robot/revoked済みhuman)× read/write/agent scopeの全組み合わせを、実Operationハンドラ・実認可境界を通して検証し、Principal状態がいかなる組み合わせでも認可結果に影響しないことを125件のアサーションで実証した(§7参照)。

### 4. 既存権限を狭めていないか

**判定: 狭めていない。** 変更ファイル一覧(`git diff HEAD --stat`)に`.claude/settings.json`・`.claude/settings.local.json`は含まれない。新規の`deny`/`ask`/`sandbox`設定を一切追加していない。既存の`scope.ts`・`hasScope()`・`AUTHZ`判定ロジックへの変更は皆無(`git diff HEAD -- src/core/scope.ts`は空)。

### 5. 既存能力を削除していないか

**判定: 削除していない。** `AuthInfo`は既存フィールドを1つも変更・削除せず、末尾に2つのoptionalフィールドを追加したのみ(`git diff`で確認可能な純追加)。既存の116件のOAuthテスト・31件のoperationsテストが無改変で全てパスすることを実測確認済み。

### 6. 認可をPrincipal必須にしていないか

**判定: 必須にしていない。** `oauth_clients.principal_id`はnullable、既定null。`principal_id IS NULL`のクライアントが通常通りscopeベースで認証・認可される(拒否も昇格もされない)ことを`test/principal-identity-foundation.test.ts`「unattributed client resolves AuthInfo with principalId/principalKind undefined, scopes unaffected」で確認済み。

### 7. 将来のPrincipal種別追加にスキーマ変更が不要か

**判定: 不要。** 上記1参照。

### 8. 既存OAuth・MCP・Connector・CLIがそのまま動作するか

**判定: 動作する。**
- OAuth: 既存116テストが無改変で全てパス。ライブサーバでclient_credentials発行・失効・失効後拒否を実機確認。
- MCP: ライブサーバで`tools/list`・`tools/call`を実機確認。
- CLI: `gbrain --version`・`gbrain init`・`gbrain doctor`・`gbrain auth register-client`・`gbrain serve --http`を実機確認、いずれもエラーなし。
- Connector: 本環境から外部Connectorクライアントを直接操作できないため未実施(`PHASE9B-TEST-EVIDENCE.md`§5に明記)。ただしOAuth discoveryメタデータ・MCPプロトコル応答という、Connectorが依拠する契約面自体は変更していないため、破壊されている可能性は低いと考えられる——ただしこれは推測であり実機確認ではないことを明記する。**(⚠️v5内部レビューで訂正)** 本項目は当初「`serve-http.ts`無変更」を根拠にしていたが、v5のREQUIRED-Bで`serve-http.ts`のCallToolRequestSchemaハンドラ内の認可判断部分に変更を行った(`authorizeOperation()`への挙動不変の抽出のみ、判定ロジック自体は無変更)。OAuth discoveryメタデータ・MCPプロトコル応答という契約面自体には触れていないため結論は変わらないが、根拠の書き方を訂正した。

### 9. Phase 9B対象外機能が紛れ込んでいないか

**判定: 紛れ込んでいない。** `grep -rn "principals\|principal_kinds\|principal_id" src/commands/serve-http.ts`は0件(§10で再掲)——管理画面API・CRUD・失効操作のいずれも実装していない。`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`§3の対象外表と実装差分を突き合わせ、一致することを確認した。

### 10. 将来のPhase 9C〜9Jを妨げる設計になっていないか

**判定: 妨げない。**
- Phase 9C(Audit Event統合): `principals`テーブルが既に存在するため、`mcp_request_log`への`principal_id`参照FK追加は素直に乗る。
- Phase 9D(Policy Decision統合): `principal_id`がPolicy Decision層に組み込まれる余地を、AuthInfoの型・DBのFK構造いずれも塞いでいない。
- Phase 9E(Delegation汎用化): `principals`/`principal_kinds`はDelegation関連のいかなるテーブル・ロジックにも触れていない。
- Phase 9F(Credential統合): `access_tokens`・`oauth_tokens`・`client_secret_hash`はいずれも無変更。
- Phase 9G(Organization/Tenant): `principals`テーブルへの`organization_id`列追加余地は、`ALTER TABLE ADD COLUMN`一つで将来対応可能な設計(現時点で先回りした列は追加していない——過剰設計を避けるため)。

### 11. 不必要な抽象化を増やしていないか

**判定: 増やしていない。** Subjectという第3の概念は明示的に不採用とした(`PHASE9A-IDENTITY-MODEL-DECISION.md`§2)。Session・Execution Instance専用テーブルも作らず、既存の`oauth_tokens`/`mcp_request_log.id`/`minion_jobs.id`をそのまま概念の実体として扱うに留めた。`principalKindLabel`のような追加フィールドも、消費者が存在しない時点では追加しなかった(§1-4参照)。

### 12. 一時しのぎのハードコードがないか

**判定: ない。** 唯一の「固定値」は`principal_kinds`の初期5行(human/service/agent/device/unknown)のブートストラップDataであり、これは要件で明示的に指定された初期データであって、かつ`ON CONFLICT DO NOTHING`でデータ行として管理される(コード分岐ではない)。認可コード側にPrincipal種別のリテラル文字列比較は一切追加していない(§3の`scope.ts`grep結果参照)。**v2で追加した`isUndefinedTableError(error, table?)`の`table`引数**は個別テーブル名へのその場しのぎの分岐ではなく、既存の`isUndefinedColumnError(error, column)`と同型の汎用パラメータ化(既存4呼び出し元は引数省略で完全後方互換)であり、`applyForwardReferenceBootstrap()`の拡張も既存の`needsOauthClientsBootstrap`等と同型の構造的パターンを踏襲したもので、Phase 9B固有の一時しのぎではない。

---

## 総合判定

12項目全てで問題は検出されなかった。1件(項目8のConnector実機確認)のみ、環境制約により直接検証できず推測に留めている点を明記した。この点を含め、外部レビューでの再確認を推奨する。

**本自己レビューは外部レビュー(ChatGPT等)の代替にはならない。** ユーザーが明示的にレビュー完了と判断するまで、Phase 9Bは正式完了として扱わない。

---

## 13. 外部敵対的レビューREQUIRED-1〜7 対応状況(v2時点の記録 — ⚠️v5内部レビューで注記追加)

> **本節はv2時点の判定であり、その後2回更新されている。** v5内部レビュー(Documentation Reviewer)が、REQUIRED-5(フルテスト正常完走)の「✓対応済み」という判定が、v2提出後にv3(patched側のみの追加3失敗を発見・修正)・v4(direct実行特有の追加2失敗+brain-repo-durability再現性を発見・調査)の2回にわたって覆された箇所であるにも関わらず、本ファイルが無改訂のままv4/v5バンドルに同梱されている点を指摘した。**REQUIRED-5の最新かつ正式な状態は`PHASE9B-TEST-EVIDENCE.md`§3-9(a〜j)を参照すること。** 本節はv2時点の記録として数値を訂正せず保持する。

初版は外部敵対的レビューで「未承認・REQUIRED 7件」と判定された。以下、各項目の対応状況と根拠(詳細は`PHASE9B-IMPLEMENTATION-REPORT.md`§8・`PHASE9B-TEST-EVIDENCE.md`各該当節参照):

| REQUIRED | 判定(v2時点) | 根拠(v2時点) |
|---|---|---|
| REQUIRED-1(Credential除去) | ✓対応済み | `credential-scan-and-destruction-log.txt`、機械grepで秘密値0件 |
| REQUIRED-2(schema Index差異) | ✓対応済み | `test/principal-schema-parity.test.ts`(13 assertion)、`test/schema-bootstrap-coverage.test.ts`(71 assertion) |
| REQUIRED-3(認可マトリクス) | ✓対応済み | `test/authorization-invariant-matrix.test.ts`(21 test / 125 assertion) |
| REQUIRED-4(pre-v125フォールバック) | ✓対応済み | `test/oauth-fallback-pre-phase9b.test.ts`(8 test / 37 assertion)、`isUndefinedTableError`narrowing |
| REQUIRED-5(フルテスト正常完走) | ⚠️v2時点は✓対応済みと判定したが、v3・v4で2回覆された。最新状態は`PHASE9B-TEST-EVIDENCE.md`§3-9参照 | (v2当時)一時worktree実行、baseline比較、release個別実行 |
| REQUIRED-6(Postgres実機) | ✓対応済み | `test/e2e/principal-postgres.test.ts`実Postgres実行 |
| REQUIRED-7(Rollback実行+完全Patch) | ✓対応済み | PGLite/Postgres両方でのrollback実行サイクル、完全Patchの空worktree適用確認 |

**再総合判定(v2)**: 12項目チェック+REQUIRED-1〜7全19項目のいずれにも未対応・矛盾は検出されなかった。ただし本節もSonnetによる自己レビューであり、外部敵対的レビューの代替にはならない点は初版と変わらない。ユーザーが外部レビューで正式承認したと判断するまで、Phase 9Bは正式完了として扱わない。

## 14. v5: 内部並列レビュー(7専門Reviewer)による補完

v2時点の本節(§13)は「Sonnetによる自己レビューであり外部敵対的レビューの代替にはならない」と明記していたとおり、限界があった。v5では外部レビュー承認を待つ間、ユーザー指示によりArchitecture/Security/Database/Migration/Testing/Performance/Documentationの7専門Reviewerによる独立した敵対的レビューを実施し、REQUIRED合計24件超を発見・全て対応した(詳細は`PHASE9B-IMPLEMENTATION-REPORT.md`§11)。これは外部レビュー(ChatGPT)の代替ではなく、それとは独立した追加の品質保証層である。外部レビューによる正式承認が確認されるまでPhase 9Bを正式完了として扱わない方針は本節でも維持する。

**第2ラウンド(再レビュー)**: §11の修正提出後、応答済みの5名(Architecture/Database/Migration/Testing/Documentation)へ再確認を依頼したところ、Migration Reviewerが元3件全てのクローズを確認する一方で新規1件を、Architecture/Database/Testing/Documentation Reviewerが独立に「§11の一部修正が関連文書の他箇所へ反映されず内部矛盾が残っている」という同一クラスの問題(計10箇所超)・CI lint違反1件・v125適用済み永続ブレインへの移行経路懸念を発見した。全て対応済み(詳細は`PHASE9B-IMPLEMENTATION-REPORT.md`§12)。Performance Reviewerからは繰り返しの依頼の後、§12の再確認ラウンド中に最終的にレポート本文が到着した(REQUIRED 1件・認可ホットパス上の冗長JOIN・Notes 6件)。REQUIRED-1は`src/core/oauth-provider.ts`から該当JOINを削除し対応・再検証済み(詳細は`PHASE9B-IMPLEMENTATION-REPORT.md`§12「追加: Performance Reviewerの初回報告とREQUIRED-1対応」)。
