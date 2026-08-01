# Phase 9B — テスト証跡

**日付**: 2026-08-01(初版) / 2026-08-01(v2、外部レビューREQUIRED-1〜7対応版) / 2026-08-01(v3、v2再レビューでのREQUIRED-1(フルUnit回帰の未解消分)対応版) / 2026-08-02(v4、v3再レビューでのREQUIRED-1(direct実行特有の追加2失敗+brain-repo-durability再現性)対応版) / 2026-08-02(v5、外部レビュー承認前の内部並列レビュー(7専門Reviewer)対応版)
**実行環境**: ローカルサンドボックス(macOS, bun 1.3.10)。v2ではDocker Desktopを起動し、`docker-compose.test.yml`の使い捨てPostgres(pgvector/pgvector:pg16, localhost:5434)で実機検証を実施(§7参照、初版のPostgres未検証を解消)。

**v2で追加した節**: §0(外部レビューREQUIRED-1〜7対応サマリ)、§3-6(REQUIRED-2 スキーマ差異解消)、§3-7(REQUIRED-3 認可不変性マトリクス)、§3-8(REQUIRED-4 pre-v125フォールバック直接検証)、§3-9(REQUIRED-5 フルスイート正常完走+baseline比較)、§7(REQUIRED-6 Postgres実機検証)、§8(REQUIRED-7 Rollback実行+完全Patch検証)。既存節(§1〜§6)は初版のまま保持し、変更点のみ追記した。

**v3改訂の要約**: v2再レビューで、§3-9の「失敗はPhase 9B適用前後で完全に同じ」という記述が実ログと不一致であること(patched側のみに3件の追加失敗)を指摘された。原因を直接調査した結果、**Phase 9Bの実装コード(`src/`配下)には一切起因しない、既存テストランナーの順序依存バグ**であることを特定した(`test/minions-shell.test.ts`の`GBRAIN_AUDIT_DIR`環境変数save/restoreの不備。詳細は§3-9改訂版)。テストファイル1件を修正し、修正前後の直接比較で解消を実証した。また、rc=143についても`run-unit-parallel.sh`を介さず各shardの`bun test`を直接実行し、実際のexit codeが143ではなく1(通常の「一部テスト失敗」終了コード)であることを直接証拠として確認した(§3-9改訂版)。§3-9を全面的に書き換え、誤った記述を修正した。

**v4改訂の要約**: v3再レビューで、v3のdirect shard実行ログにpatched側のみのさらに2件の追加失敗(`longmemeval-trajectory-routing.test.ts`のperf gate、`page-search-vector-overflow.test.ts` #2704)が存在し、「baselineとpatchedのfail集合は一致する」という v3 §3-9-e の記述がやはり実ログと不一致であることを指摘された。**これは私自身の見落としであり、v3時点での「一致確認」は網羅的な機械diffではなく、shard単位のpass/fail件数を目視で突き合わせただけの不十分な検証だったことが根本原因である。** 今回は同一の誤りを繰り返さないため、3つの独立した専門タスク(baseline/patched単独性能比較×2、fail集合の機械diff×1)を並列サブエージェントに委譲し、加えて自分自身でv3報告書中の未検証の主張(`brain-repo-durability.serial.test.ts`「再実行で解消」の再現性)を直接検証した。結論として**4件全て(longmemeval・page-search-vector-overflow・brain-repo-durability・監査手法自体の限界)がPhase 9Bの実装コード(`src/`配下)とは無関係**であることを、baseline側での再現実験を含む直接証拠で確認した。ソースコードの変更は一切不要と判定し、本ラウンドでの実ファイル変更はない(`phase9b-code-changes-v4.diff`は`phase9b-code-changes-v3.diff`とバイト単位で同一)。§3-9に新規節(3-9-f〜3-9-j)を追加し、§3-9-eの誤った結論を訂正した。

**v5改訂の要約**: 外部レビュー承認前にユーザー指示で実施した内部並列レビュー(7専門Reviewer)の初回ラウンドの実測証跡を§11に追加した。その後の再レビュー(第2ラウンド)でArchitecture/Database/Testing/Documentation Reviewerが独立に、§11の一部修正が本ファイルの他箇所(§0・§3-1・§3-5・§3-7・§3-8・§3-9・§5・§6・§11-1・§11-4)へ反映されず生じた内部矛盾・数値不一致・記述陳腐化を発見した。本ラウンドで該当箇所を全て訂正し(訂正箇所は「⚠️v5内部レビューで訂正」等の形で明示、無言の書き換えはしていない)、テスト隔離CI lint違反の修正結果を§12に追加した。詳細は`PHASE9B-IMPLEMENTATION-REPORT.md`§12参照。

---

## 0. 外部レビューREQUIRED-1〜7 対応サマリ

| REQUIRED | 内容 | 状態 | 証跡 |
|---|---|---|---|
| REQUIRED-1 | 成果物からCredential除去 | ✓完了 | `credential-scan-and-destruction-log.txt`、機械grep 0件 |
| REQUIRED-2 | fresh/migrated schema Index差異解消 | ✓完了 | §3-6、`test/principal-schema-parity.test.ts`(13 assertion pass) |
| REQUIRED-3 | 認可不変性テストの完全マトリクス化 | ✓完了 | §3-7、`test/authorization-invariant-matrix.test.ts`(21 test / 125 assertion pass。**⚠️v2時点の値。v5でREQUIRED-B/E/Fにより拡充され49 test / 185 assertionへ増加、§11-2参照**) |
| REQUIRED-4 | pre-v125フォールバック直接テスト | ✓完了 | §3-8、`test/oauth-fallback-pre-phase9b.test.ts`(8 test / 37 assertion pass。**⚠️v2時点の値。v5でREQUIRED-G/Hにより拡充され9 test / 43 assertionへ増加、§11-5参照**)、`isUndefinedTableError`のtable引数narrowing |
| REQUIRED-5 | フルテスト正常完走 | ✓完了(v4で再対応) | §3-9、patched側のみの追加3失敗(v3)を`test/minions-shell.test.ts`の既存隔離バグと特定・修正。direct実行特有の追加2失敗(v4、longmemeval・page-search-vector-overflow)を個別に原因特定しPhase 9B非起因と確認。`brain-repo-durability`の再現性をbaseline側でも直接検証。`run-unit-parallel.sh`を介さない直接exit code取得(全shard/serialとも1、143ではない) |
| REQUIRED-6 | Postgres実機検証 | ✓完了 | §7、`test/e2e/principal-postgres.test.ts`実Postgres実行結果 |
| REQUIRED-7 | Rollback実行(PGLite+Postgres)・完全Patch検証 | ✓完了 | §8 |

**v3再レビュー対応**: REQUIRED-1(v2 patched側のみの追加3失敗) — ✓完了(§3-9参照)。
**v4再レビュー対応**: REQUIRED-1(v3 direct実行特有の追加2失敗+brain-repo-durability再現性未検証) — ✓完了(§3-9-f〜3-9-j参照)。
**v5内部レビュー対応**: 外部レビュー承認前にユーザー指示で実施した内部並列レビュー(7専門Reviewer)がREQUIRED合計24件超を発見、全て対応 — ✓完了(§11参照)。§3-9関連の記述訂正(算術ミス・生ログ不一致等)も本ラウンドで実施した。

---

## 1. 型チェック

```
$ bun run typecheck
$ tsc --noEmit
```
**結果**: エラー0件(出力なし)。

## 2. 静的チェック(`check:*`スクリプト、lintに相当)

`bun run check:all`は`&&`連結のため最初の失敗で停止する。個別に実行した。

**⚠️v5内部レビュー(Documentation Reviewer)で訂正**: `package.json`の`check:all`は実際には22スクリプトを連結しており、当初の本節は先頭2つ(`check-privacy.sh`・`check-proposal-pii.sh`)を欠いた20スクリプトしかカバーしていなかった(「全19+1スクリプトを実行した」という網羅主張が実態と不一致だった)。2件を追加実行し、いずれもOK(exit 0)を確認した。

| スクリプト | 結果 |
|---|---|
| check-privacy **(v5追加)** | OK |
| check-proposal-pii **(v5追加)** | OK |
| check-search-path | OK |
| check-jsonb-pattern | OK |
| check-admin-scope-drift | OK |
| check-source-id-projection | OK |
| check-source-config-leak | OK |
| check-progress-to-stdout | OK |
| check-no-legacy-getconnection | OK |
| check-trailing-newline | OK |
| check-wasm-embedded | OK |
| check-exports-count | OK |
| check-admin-build | OK |
| check-cli-executable | OK |
| check-skill-brain-first | OK |
| check-operations-filter-bypass | OK |
| check-gateway-routed-no-direct-anthropic | OK |
| check-worker-pool-atomicity | OK |
| check-key-files-current-state | OK |
| check-no-double-retry | OK |
| check-batch-audit-site | OK |
| check-test-real-names | **FAIL(既存)** — `test/autopilot-install.test.ts`の"Hermes"参照。`git diff HEAD`が空(Phase 9B未変更ファイル)。直近コミットは無関係な#2013(autopilot cron修正) |
| check-test-isolation | **FAIL(既存)** — `test/put-page-remote-auto.test.ts`の`process.env.GBRAIN_REMOTE_AUTO_LINK`直接操作。`git diff HEAD`が空(Phase 9B未変更ファイル) |

**結論**: Phase 9Bが変更したファイルに起因する静的チェック失敗はゼロ。2件の失敗はいずれもPhase 9Bが一切触れていないファイルで発生する既存の問題。

## 3. Unit Tests

### 3-1. Phase 9B専用新規テスト

```
$ bun test test/principal-identity-foundation.test.ts
 13 pass
 0 fail
 26 expect() calls
```
**⚠️v2時点の値。v5でREQUIRED-A(#10のテストをON DELETE RESTRICT検証へ書き換え)により29 expect() callsへ増加、§11-1参照。**

ユーザー指定の最低10項目(異なるkindで同一scope→同一結果／Principal未紐付けClientの既存動作／紐付けによる権限不変／revoked_atでの結果不変／新kindのデータ追加のみでの拡張／未知kindでの認可コア無変更動作／製品名等でscope自動付与しない／新規Client登録時principal_id=null／存在しないPrincipalへのFK失敗／Principal削除時の監査参照非破壊)を全て自動テスト化し、全てパス。

### 3-2. スキーマ・マイグレーション回帰

```
$ bun test test/schema-bootstrap-coverage.test.ts
  [125] principal_identity_foundation...
  v125: principal_kinds + principals tables added; ...
  [125] ✓ principal_identity_foundation
  120 migration(s) applied
 9 pass / 0 fail / 68 expect() calls
```
version 1から125までの全マイグレーション連続実行がエラーゼロで完走。新規DB初期化+フルアップグレード経路の実機検証。

### 3-3. OAuth回帰(既存テスト、`verifyAccessToken`変更の直接検証)

```
$ bun test test/oauth.test.ts test/oauth-confidential-client.test.ts test/oauth-authorize-scope-default.test.ts test/oauth-scope-probe.test.ts
 116 pass / 0 fail / 460 expect() calls
```

### 3-4. Operations回帰

```
$ bun test test/operations-trust-boundary.test.ts test/operations-allow-list.test.ts test/operations-fuzzy-source-scope.test.ts
 31 pass / 0 fail / 401 expect() calls
```

### 3-5. フルUnitスイート(`bash scripts/run-unit-parallel.sh`)(初版時点の記録 — ⚠️v5内部レビューで注記追加)

> **本節は初版(v1)提出時点のフルUnitスイート実行記録であり、それ以降更新されていない。** v5内部レビュー(Documentation Reviewer)が、本節が参照する`test-log-02`がいずれのバンドルバージョンにも同梱されていないこと、および`pass=3417 fail=14 elapsed=1651s`という数値がフルスイート全体(14,000件超)の1/4程度しかなく、恐らく単一shardの数値であることを指摘した。**フルUnitスイートの正式かつ最新の実行証跡は§3-9(REQUIRED-5、v2〜v5で複数回更新済み、生ログ同梱)を参照すること。** 本節は初版当時の記録として、数値を訂正せずそのまま残す(参照用、正式な証跡としては§3-9を優先すること)。

```
elapsed=1651s
pass=3417  fail=14  skip=0
```

**14件の失敗の内訳と原因確認**(全てPhase 9B以前から存在する、または環境要因):

| ファイル | 原因 | 検証方法 |
|---|---|---|
| `test/hybrid-meta.serial.test.ts` | 既存(reranker関連) | git stashでPhase 9B変更を退避し再実行 → 同一失敗を確認 |
| `test/search/autocut-integration.serial.test.ts` | 既存(reranker関連) | 同上 |
| `test/search/hybrid-reranker-integration.serial.test.ts` | 既存(reranker順序アサーション) | 同上 |
| `test/worker-registry.serial.test.ts` | 既存(niceness読み取り) | 同上、stash後も同一失敗(5 pass/1 fail)を確認 |
| `test/release/build-release.serial.test.ts` | **Phase 9Bのコードではなく、Phase 9B自身の未コミット差分の存在**が原因。このテストは`git diff HEAD`の形を厳密にアサートする設計であり、Phase 9Bの正当な未コミット変更(schema.sql等6ファイル)が存在すること自体が期待diffを膨らませる。stash後(クリーンな木)では0 fail | git stashで空木にして再実行→0 fail、stash復元後に単独実行→3 fail(diff内容起因のアサーション不一致)を確認。**注(v5): `test-log-02`はいずれのバンドルにも同梱されていない。** この2ファイルの最新のPASS実測は§3-9-c末尾(検証専用worktreeでの個別実行、直接観測)を参照 |
| `test/release/deploy.serial.test.ts` | 上記と同一原因と推定(自身の docstring で`build-release.sh`を内部利用すると明記) | **個別のstash再検証は未実施**(重量級テストのため時間予算内で省略)。推定であり直接観測ではないことを明記する。同上、最新実測は§3-9-c参照 |

**結論**: Phase 9Bのコード変更自体に起因する機能的リグレッションは1件も確認されなかった。

### 3-6. REQUIRED-2: fresh/migrated schema Index差異の解消

**問題**: 初版はマイグレーションv125内のみに`idx_oauth_clients_principal_id`を作成し、`src/schema.sql`/`src/core/pglite-schema.ts`/`src/core/schema-embedded.ts`(fresh schema正本)には含めていなかった。理由は「旧ブレインの`CREATE TABLE IF NOT EXISTS oauth_clients`がno-opになり、その後の`CREATE INDEX`がまだ存在しない`principal_id`列を参照してクラッシュする」というforward-reference問題を避けるためだったが、これはfresh DBとmigrated DBのスキーマ差異(REQUIRED-2)を生む未承認の設計だった。

**修正**: 本リポジトリの既存機構`applyForwardReferenceBootstrap()`(`src/core/pglite-engine.ts`・`src/core/postgres-engine.ts`)を拡張し、`needsPrincipalIdBootstrap`フラグ(`information_schema`の1往復プローブ)を追加。旧ブレインでは`CREATE TABLE`/`ALTER TABLE ... ADD COLUMN`の実体化をスキーマblob再生の**前に**先行実行するようにし、Indexをfresh schema正本3ファイルへ追加した。マイグレーションv125自体は無変更(既に冪等)。

**実行結果**:
```
$ bun test test/principal-schema-parity.test.ts
 1 pass / 0 fail / 13 expect() calls
```
fresh PGLiteエンジンと、"fully-init→v125オブジェクトをDROP→config.version='124'に巻き戻し→initSchema()再実行"で作った擬似migrated PGLiteエンジンの、列・Index・FKを`test/helpers/schema-diff.ts`のスナップショット比較で機械比較し、完全一致を確認(Index存在をfresh/migrated両側で個別assertする冗長チェックも含む)。

```
$ bun test test/schema-bootstrap-coverage.test.ts
 9 pass / 0 fail / 71 expect() calls
```
既存の「forward-reference bootstrap保守契約」テストに`principal_kinds`/`principals`/`oauth_clients.principal_id`の3エントリを追加し、DROP→再bootstrap→再出現のサイクルを実証。

### 3-7. REQUIRED-3: 認可不変性テストの完全マトリクス化

**追加ファイル**: `test/authorization-invariant-matrix.test.ts`(新規)

初版の`test/principal-identity-foundation.test.ts`は`hasScope()`単体の比較が中心だった。REQUIRED-3はこれを実Operation・実認可境界を通す統合テストへ拡張することを要求した。

**認可境界の実装調査**: `src/mcp/dispatch.ts`の`dispatchToolCall()`自体はscope enforcementを一切行わない(`grep -n "hasScope|requiredScope|ctx.auth" src/mcp/dispatch.ts`は0件)。実際のscope gateは`src/commands/serve-http.ts`のCallToolRequestSchemaハンドラが`dispatchToolCall`呼び出し**前**に行う`hasScope(authInfo.scopes, op.scope || 'read')`である。この時点(v2)では`serve-http.ts`をPhase 9Bの変更禁止領域とし、テスト側で同じ2段階(hasScopeゲート→通過時のみdispatchToolCall呼び出し)を再現する`callThroughBoundary()`ヘルパーを実装して本番の認可境界を再現していた。**(⚠️v5内部レビューで訂正)** Architecture/Testing Reviewerの指摘により、この「再現」が本番コードの手写しに留まり本番変更への追随性がないという構造的リスクが判明したため、v5のREQUIRED-Bで`src/core/scope.ts`に`authorizeOperation(scopes, op)`を新規抽出(`serve-http.ts`側の該当2行を挙動不変のまま移動)し、`callThroughBoundary()`はこの実関数をimportして呼ぶよう置き換えた。現在は本番の実ゲートを直接検証している。詳細は`PHASE9B-IMPLEMENTATION-REPORT.md`§11 REQUIRED-B参照。

**マトリクス構成**(全て実Principal行・実OAuth Client・実`verifyAccessToken()`・実Operationハンドラを使用):
- Principal状態8種: `principal_id=null`、`human`/`service`/`agent`/`device`/`unknown`(既定5種)、実行時追加kind`robot`、`revoked_at`設定済み`human`
- read scope: 全8状態でread成功・write拒否(write側は`callThroughBoundary`が`allowed:false`を返し、ハンドラが**呼び出されない**ことを`result`が`undefined`であることで確認)
- write scope: 全8状態でread成功・write成功・`delete_page`(scope='write'、put_pageと同一。「既存delete挙動不変」を`operations.find(o=>o.name==='delete_page').scope`が`'write'`であることの直接assertで裏付け)成功
- agent scope: scope無し+kind='agent'→ブロック(kindだけではscopeは付与されない)/ scope有り+kind='human'→ハンドラ到達(kind不一致でも既存仕様どおり動作)/ scope有りでkind='agent'とkind='human'のハンドラ結果が完全一致(bound_tools未設定による同一permission_denied)
- Principal関連付け前後の認可結果一致: read scope・write scopeそれぞれで、同一Clientに対しPrincipal紐付け前後の`hasScope`判定・ハンドラレスポンスが完全一致することを確認

**実行結果**:
```
$ bun test test/authorization-invariant-matrix.test.ts
 21 pass / 0 fail / 125 expect() calls
```
**⚠️v2時点の値。v5でREQUIRED-B/E/Fにより49 pass / 185 expect() callsへ拡充、§11-2参照。**

### 3-8. REQUIRED-4: pre-v125フォールバックの直接検証 + `isUndefinedTableError`のnarrowing

**追加ファイル**: `test/oauth-fallback-pre-phase9b.test.ts`(新規)

**構成済みDB状態5種を直接`verifyAccessToken()`へ通した**(単一PGLiteエンジン上で累積的にオブジェクトをDROPしながら段階的に検証):
1. `principal_id`列なし(principals/principal_kindsテーブルは存在)→認証成功、principalId/principalKind=undefined、source_id/federated_read健全
2. `principals`テーブルもなし→同上
3. `principal_kinds`テーブルもなし(真のpre-v125形状)→同上
4. pre-v61相当(`federated_read`列もなし)→v60専用射影へフォールバック、`allowedSources`=undefined
5. pre-v60相当(`source_id`列もなし)→最古の射影へフォールバック、`sourceId`/`allowedSources`とも=undefined、`clientId`/`scopes`は健全

**`isUndefinedTableError`の狭小化**: レビュー指摘「`isUndefinedTableError(err0)`の無条件使用は広すぎる」を検証した結果、`oauth_tokens`/`oauth_clients`自体が存在しないケースでは内側フォールバッククエリが同一エラーで再度失敗し最終的にthrowされるため実害はなかったが、防御的観点および将来の保守性のため`src/core/utils.ts`の`isUndefinedTableError(error, table?)`に任意の`table`引数を追加(既存4呼び出し元は引数省略で完全後方互換)、`oauth-provider.ts`側は`isUndefinedTableError(err0, 'principals') || isUndefinedTableError(err0, 'principal_kinds')`へ限定した。

**無関係なTable欠落がthrowされることの直接確認**:
```ts
test('isUndefinedTableError(err, table) requires the named table to appear in the message', ...)
test('oauth_tokens missing entirely: verifyAccessToken throws rather than returning a degraded-but-successful AuthInfo', ...)
```
`oauth_tokens`テーブル自体をDROPした状態で`verifyAccessToken()`を呼ぶと、握り潰されず`reject`されることを実測。

**実行結果**:
```
$ bun test test/oauth-fallback-pre-phase9b.test.ts
 8 pass / 0 fail / 37 expect() calls
```
**⚠️v2時点の値。v5でREQUIRED-G/Hにより9 pass / 43 expect() callsへ拡充、§11-5参照。**

**回帰確認**(REQUIRED-2〜4関連ファイル一括):
```
$ bun test test/principal-identity-foundation.test.ts test/principal-schema-parity.test.ts \
    test/schema-bootstrap-coverage.test.ts test/authorization-invariant-matrix.test.ts \
    test/oauth-fallback-pre-phase9b.test.ts test/operations-trust-boundary.test.ts
 66 pass / 0 fail / 647 expect() calls (6 files)
```
`bun run typecheck`もエラー0件で通過。

**回帰確認(v3、§9のminions-shell.test.ts修正を含む、本番と同じ`--max-concurrency=4`で実行)**:
```
$ bun test --max-concurrency=4 test/principal-identity-foundation.test.ts test/principal-schema-parity.test.ts \
    test/schema-bootstrap-coverage.test.ts test/authorization-invariant-matrix.test.ts \
    test/oauth-fallback-pre-phase9b.test.ts test/principal-rollback-pglite.test.ts \
    test/operations-trust-boundary.test.ts test/minions-shell.test.ts \
    test/audit/audit-dir-preload.test.ts test/subagent-audit.test.ts
 124 pass / 0 fail / 777 expect() calls (10 files)
```
実`~/.gbrain/audit`への新規漏洩なしを確認(`ls ~/.gbrain/audit/ | grep content-sanity`が空)。`bun run typecheck`もエラー0件。

### 3-9. REQUIRED-5: フルUnitスイートの正常完走 + baseline比較(v3で全面改訂)

**環境**: `git worktree add -b phase9b-required-remediation-verify <tmp-path> HEAD`で作成した一時worktree(実working treeは無変更)。Phase 9Bの完全Patch(v2時点: 追跡済み変更10件+新規テスト6件)を適用し、`git commit`で検証専用コミット(`ccb076ca`、実masterには一切影響しない)を作成。v3ではさらに§3-9-bの1行修正を同worktree内に追加コミット(`1174399d`)。

**⚠️v5内部レビュー(Migration/Testing/Documentation Reviewerが独立発見)で判明した適用範囲の限界**: 上記「新規テスト6件」のうち`test/principal-rollback-pglite.test.ts`・`test/e2e/principal-postgres.test.ts`の2件は、この検証用worktree(`1174399d`時点)には実際にはコミットされておらず(`git ls-tree`で不在確認済み)、以下の§3-9(a〜j)の全shard・フルスイート実測はいずれも**新規テスト6件中4件のみを含む1020ファイルのツリー**に対するものだった。v5でこの2ファイルを別途worktreeへ追加・コミット(`471e0e0b`)したが、**フルスイート・全shardの再実行はv5では行っていない**。この2ファイルはそれぞれ§8-1(PGLite rollback、4 pass)・§7(Postgres実機、13 passに含む)・§11-1で個別に実行しPASS確認済みであり、Phase 9B専用テストとしての正しさは検証済みだが、「他の全既存テストと同時実行しても衝突・副作用が生じないか」というREQUIRED-5本来の観点での確認は、この2ファイルについては個別実行の範囲に留まる。

**v2時点の誤り(v2再レビューで指摘・訂正)**: v2の本節は「失敗する4つのserialファイルは完全に同一」という**serial phaseに限った**正しい観測を、誤ってparallel phase全体にも一般化し、「parallel段の個別失敗も…既存の環境依存フレーキーテストであることを確認した」と記述していた。実際にはparallel phaseにpatched側のみの追加失敗が3件存在しており(`test/audit/audit-dir-preload.test.ts`の3テスト全て)、これを個別に検証しないまま「確認した」と書いたのは誤記だった。v3で原因を特定し、本節を全面的に書き直した。

#### 3-9-a. patched側のみの追加失敗3件 — 原因調査と直接証拠

**症状**: v2のフルスイート実行で、baseline(pass=14054 fail=15)に対しpatched(pass=14094 fail=18)が3件多く失敗。差分はparallel phaseのshard 4に集中しており、全て`test/audit/audit-dir-preload.test.ts`(#2823のregression gateテスト、Phase 9Bとは無関係の既存ファイル)の3テスト:
- `GBRAIN_AUDIT_DIR is set by the preload to a scratch dir, not the real ~/.gbrain/audit`
- `resolveAuditDir() resolves to the preload-set scratch dir`
- `an oversize content-sanity event ... never reaches the real ~/.gbrain/audit`

3件とも`process.env.GBRAIN_AUDIT_DIR`が`undefined`になっていることが原因で失敗しており、3件目は実際に**操作者の実`~/.gbrain/audit/content-sanity-2026-W31.jsonl`へテストのsentinelイベントが漏れていた**(該当ファイルの内容を確認し、テスト由来の2行のみで構成されていたため削除済み。実データの汚染はなかった)。

**切り分け手順(実施した通り)**:
1. `test/audit/audit-dir-preload.test.ts`を単体実行 → 3 pass / 0 fail(Phase 9B自身のsrc変更には起因しないことを確認)。
2. `GBRAIN_AUDIT_DIR`を扱う全テストファイルを`grep`で洗い出し、`test/minions-shell.test.ts`に**無条件の**`delete process.env.GBRAIN_AUDIT_DIR`(元の値を保存せず削除するだけ)が`describe('shell-audit: write')`の`afterAll`にあることを発見。他の同種ファイル(`test/subagent-audit.test.ts`等)は`if (saved === undefined) delete ...; else process.env.X = saved;`という正しい保存/復元パターンを使っており、`minions-shell.test.ts`だけがこのパターンを欠いていた。
3. **最小再現**(修正前): `bun test test/minions-shell.test.ts test/audit/audit-dir-preload.test.ts` → **3 fail**(上記3件、エラー内容も本番failと完全一致、実`~/.gbrain/audit`への漏洩も再現)。
4. `scripts/run-unit-shard.sh`のシャーディングアルゴリズム(`(索引 % 4) + 1`、ソート済み全ファイルリストに対する位置ベース)を読み、baseline(1016ファイル)とpatched(1020ファイル、Phase 9Bが4ファイル追加。**⚠️v5訂正: この4ファイルは新規テスト6件中4件のみで、残り2件は当時このworktreeに未コミットだった。詳細は§3-9冒頭の注記参照**)の双方でどのファイルがshard 4に入るか実際に計算・比較した。`test/audit/audit-dir-preload.test.ts`自身の索引は両者で同一(56番目、shard 4)だが、`test/minions-shell.test.ts`はbaselineでは別shardに、patchedではshard 4に入っていた(shard内の他ファイルの索引がPhase 9Bのファイル追加でシフトしたため)。**Phase 9Bのテストファイル自体はいずれも`GBRAIN_AUDIT_DIR`を一切参照しない(grep 0件)** ため、原因はPhase 9Bの新規テストの隔離不良ではなく、既存の`minions-shell.test.ts`の隔離不良が、既存のシャーディング方式の位置依存性によって偶然shard 4へ再配置され、露呈したもの。

**結論**: 原因はPhase 9Bの実装(`src/`)にもPhase 9Bの新規テストにも一切ない、**既存ファイル`test/minions-shell.test.ts`の孤立した隔離バグ**(#2823の趣旨に反する退行)。ユーザー指定の合格条件に従い、この既存バグを修正した(以下)。

**修正**: `test/minions-shell.test.ts`の`describe('shell-audit: write')`ブロックに、`test/subagent-audit.test.ts`と同じ保存/復元パターンを追加(モジュールロード時点—プリロード適用後—の値を`savedAuditDir`として保存し、`afterAll`で無条件deleteではなく保存値へ復元)。

**修正後の直接検証**:
```
$ bun test test/minions-shell.test.ts test/audit/audit-dir-preload.test.ts
 43 pass / 0 fail / 72 expect() calls  [2.65s]
```
実`~/.gbrain/audit`への新規漏洩なしを確認(修正前に発生した汚染ファイルは削除済み)。

**修正後、patched shard 4の全255ファイルを実際に再実行**(`scripts/run-unit-parallel.sh`を介さず直接):
```
$ bun test --max-concurrency=4 --timeout=60000 <shard4の255ファイル>
 3642 pass / 3 skip / 0 fail / 9005 expect() calls
Ran 3645 tests across 255 files. [2072.06s]
```
修正前のpatched shard 4(`pass=3639 fail=3 skip=3`)から**fail=3→0**、pass=3639→3642(3件が失敗からPASSへ移行)を実測確認。`bun run typecheck`もエラー0件。

#### 3-9-b. rc=143 について — 直接証拠(推測ではない)

外部レビュー指摘の通り、`Ran N tests`完了行の存在だけをもって正常終了と扱わず、**`scripts/run-unit-parallel.sh`を介さず4 shard全ての`bun test`コマンドを直接実行し、実際のexit codeを取得した**(選択肢A)。

```
$ cd <worktree> && bun test --max-concurrency=4 --timeout=60000 <shard1の255ファイル>; echo $?
→ 1   (3368 pass / 3 fail / Ran 3371 tests across 255 files. [3140.59s])

$ ... <shard2>; echo $?
→ 1   (3565 pass / 15 skip / 1 fail / Ran 3581 tests across 255 files. [2684.44s])

$ ... <shard3>; echo $?
→ 1   (3520 pass / 3 fail / Ran 3523 tests across 255 files. [2621.70s])

$ ... <shard4、修正後>; echo $?
→ 1   (3642 pass / 3 skip / 0 fail / Ran 3645 tests across 255 files. [2072.06s])
```
**⚠️v5内部レビュー(Documentation Reviewer)で訂正**: 上記shard4の行は当初`9004 expect() calls / [1924.58s]`と誤って引用されていた。バンドル内の実ログ(`required5-v3-shard4-direct-postfix-0fail.log`)を再確認したところ実際は`9005 expect() calls / [2072.06s]`であり、pass/fail/skip数自体は一致していたが、逐語引用として提示していた数値の一部が別実行のものと混同されていた。§3-9-aおよび本節の計3箇所を実ログの値に訂正した。

**4 shard全てが、`run-unit-parallel.sh`を介さず直接実行すると、bunの標準的な「一部テスト失敗」終了コードである`1`を返す(143ではない)。** これは`scripts/run-unit-parallel.sh`(またはそれを起動していたこのサンドボックスの外側のプロセス監視ループ)がbunの子プロセス終了後に`$?`を上書きしている、または`bun test`プロセスへ外部からSIGTERM(15、128+15=143)を送るなんらかのプロセスグループ挙動が、本ランナースクリプト自体の恒久修正が必要な別問題として存在することを示す直接証拠である。**ランナースクリプト自体の修正はPhase 9Bのスコープ外であり本番コードには含めていない**(`scripts/run-unit-parallel.sh`は無変更)。上記の直接コマンド実行が、Phase 9Bの検証において正式な「正常完走」証跡となる。

#### 3-9-c. Serial結果(90ファイル、`run-unit-parallel.sh`を介さず直接実行)

**方法論の訂正**: 当初、90ファイルを1回の`bun test file1 file2 ... file90`にまとめて直接実行したところ29件もの失敗が出たが、これは誤った検証方法だった。`scripts/run-serial-tests.sh`自身のコメントに明記されている通り、serialテストは「1ファイル=1 bunプロセス」で実行する設計になっている(同一プロセス内でファイルをまとめると、`mock.module`等のモジュールレジストリ状態がファイル間で漏れるため)。正しくは`bash scripts/run-serial-tests.sh`(`run-unit-parallel.sh`は経由しない、ファイル単位のループ自体は本スクリプトの既存実装)を直接実行し、実際のexit codeを取得した:

```
$ bash scripts/run-serial-tests.sh; echo $?
→ 1

[serial-tests] 5 file(s) failed:
  - test/brain-repo-durability.serial.test.ts
  - test/hybrid-meta.serial.test.ts
  - test/search/autocut-integration.serial.test.ts
  - test/search/hybrid-reranker-integration.serial.test.ts
  - test/worker-registry.serial.test.ts
```

`run-serial-tests.sh`は1ファイルごとに独立した`bun test`プロセスを起動するため、**単一プロセスの終了コードではなくファイルごとのループ集計**であり、143のようなシグナル起因の値は構造的に発生し得ない(`exit 1`はスクリプト自身が`fail_count > 0`のときに明示的に返す値)。

**`test/brain-repo-durability.serial.test.ts`(新出)の切り分け — ⚠️v5内部レビューで訂正、§3-9-hを正としてこの小節を置き換える**: このファイルはv2の元のbaseline/patched比較ではどちらのログにも出現していなかった(bunのデフォルトreporterはPASSしたファイルを出力しないため、両方で無言PASSしていたと考えられる)。~~今回失敗した原因は`git push origin`コマンドの失敗であり、単体で即座に再実行したところ19 pass / 0 failで問題なく成功した。これはgit push経路のネットワーク/一時的な環境要因によるflakinessであり、Phase 9Bの変更・`minions-shell.test.ts`の修正のいずれとも無関係と判断した(再実行で即座に解消することがその直接証拠)。~~ **この記述はv4時点でのもので、たった1回の再実行結果のみに基づく不十分な検証だった上、裏付けログもバンドルに含まれていなかった。** v5内部レビュー(Documentation/Testing Reviewer)の指摘を受け、baseline/patched双方で3回ずつ再実行した結果、**baseline 1/3回・patched 2/3回、いずれも同一のエラーシグネチャ(ローカルのbareリポジトリへの`git push`失敗、ネットワーク要因ではない)で間欠的に失敗する既存のflakyテスト**であることが判明した(baseline側=Phase 9Bコード変更ゼロでも同程度の頻度で再現することが、Phase 9B非起因であることの直接証拠)。正しい結論・再実行ログは§3-9-hを参照。

**残る4件**(hybrid-meta / autocut-integration / hybrid-reranker-integration / worker-registry)はv2で既に確認済みの、baseline/patched双方に同一内容で存在する既存の環境依存フレーキーテスト。

**`release/build-release.serial.test.ts` / `release/deploy.serial.test.ts` — 個別実行**(v2から変化なし、直接観測でPASS):
```
$ bun test --max-concurrency=1 --timeout=120000 test/release/build-release.serial.test.ts
 3 pass / 0 fail / 25 expect() calls  [17.38s]

$ bun test --max-concurrency=1 --timeout=120000 test/release/deploy.serial.test.ts
 5 pass / 0 fail / 17 expect() calls  [65.97s]
```
(この2ファイルは検証専用worktree内のクリーンなgit状態でのみ意図通りPASSする — `git diff`の内容に依存するアサーションを含むため。実working treeの未コミット差分に対して実行すると`brain-repo-durability`同様の性質の失敗を起こすことを確認したが、これはテストの前提条件(クリーンなgit tree)を満たしていない誤った実行方法によるものであり、検証専用worktreeでの実行が正しい検証方法である。)

#### 3-9-d. baseline比較(同一環境・同一コマンド)

```
shard 1/4: pass=3417 fail=0 skip=0
shard 2/4: pass=3478 fail=1 skip=15
shard 3/4: pass=3553 fail=2 skip=0
shard 4/4: pass=3606 fail=2 skip=3
[serial-tests] 4 file(s) failed:
  - test/hybrid-meta.serial.test.ts
  - test/search/autocut-integration.serial.test.ts
  - test/search/hybrid-reranker-integration.serial.test.ts
  - test/worker-registry.serial.test.ts
[unit-parallel] elapsed=2643s | pass=14054 fail=15 skip=18
```
(**v5内部レビュー補足**: このbaseline実行も`run-unit-parallel.sh`のラッパー経由では`rc=143`を返している。これはpatched側で§3-9-bが論じている「rc=143はPhase 9Bとは無関係のランナー側事象」という結論を独立に補強する事実であり、baseline=Phase 9Bコード変更ゼロでも同じrc=143が発生することを示す。)

#### 3-9-e. 結論(v3、直接観測) — ⚠️v4で訂正

**この節の「修正後、baselineとpatchedのfailテスト集合は一致する」という結論は、v4再レビューで再び不正確であることが判明した。** v3時点の「一致確認」は、baseline側の`run-unit-parallel.sh`ラッパー経由ログとpatched側のdirect実行ログとの間で、shard単位のpass/fail**件数**を突き合わせただけであり、テスト名レベルの網羅的な機械diffではなかった。そのため、direct実行(`SHARD`環境変数未設定・`run-unit-parallel.sh`を介さない直接`bun test`呼び出し)特有の追加失敗2件(`longmemeval-trajectory-routing.test.ts`のperf gate、`page-search-vector-overflow.test.ts` #2704)を見落としていた。加えて、同じくdirect実行でのみ出現した`test/brain-repo-durability.serial.test.ts`について「再実行で即座に解消する一過性のflakiness」と記載したが、この判定はたった1回の再実行結果のみに基づいており、それを裏付けるログもバンドルに含めていなかった。

**この節の結論は§3-9-jに置き換える。** 以下§3-9-f〜3-9-iで、v4での原因調査と直接証拠を示す。BATCH_AUDIT_SITES enum・run-unit-parallel.sh自己テスト・autocut/hybridSearch reranker・op-layer capture・register worker・hybrid-meta等、baseline/patched双方に同一ファイル・同一エラー内容で存在する15件の既存フレーキーテストについての記述(Phase 9B変更ファイルには一切関係しない)は、§3-9-iの機械diffで改めて裏付けが取れており、変更していない。

#### 3-9-f. v4 — `longmemeval-trajectory-routing.test.ts`のperf gate失敗: 原因調査と直接証拠

**症状(v3のdirect実行ログで発見)**: `test/longmemeval-trajectory-routing.test.ts` の `runEvalLongMemEval — perf gate preserved > run completes for the 2-question fixture in under 10s with stubs` が、shard1のdirect実行ログでのみ27206.54ms(閾値10000ms)で失敗。baseline/patched双方の`run-unit-parallel.sh`経由full-suiteログには一切出現しない(後述3-9-iで機械的に確認)。

**調査は専門サブエージェント(v4-agentA-longmemeval)へ委譲し、baseline worktree(`6906ab99`)とpatched worktree(`1174399d`)を用いて実施した。**

**根本原因(構造的事実として特定)**: このテストファイル自体が`process.env.SHARD`の有無で許容閾値を切り替える設計になっている:

```ts
const SHARD_MODE = !!process.env.SHARD;
const PERF_CEILING_MS = SHARD_MODE ? 60_000 : 10_000;
```

そして`scripts/run-unit-parallel.sh:133`が各shard起動時に`env SHARD="$i/$N" bash scripts/run-unit-shard.sh ...`として`SHARD`を設定する設計になっている。つまり**通常のwrapper経由では60秒閾値が適用され、27206msは合格する**。v3で行った「direct実行によるrc=143の直接証拠取得」は`SHARD`を設定せずに`bun test`を直接呼び出していたため、shard並列負荷という重い実行条件に対して単独実行用の厳しい10秒閾値を誤って適用してしまっていた。テスト自身のコード内コメントもこの並列負荷シナリオを想定済みと明記している。

**Step1: 単独実行タイミング(各3回、`ps aux`で他のbun testプロセスがないことを実行毎に確認)**:

| # | 側 | HEAD | load(前→後) | 結果 | ファイル合計時間 | exit |
|---|------|------|------------------------|--------|-----------|------|
| 1 | baseline | `6906ab99` | 5.28→5.71 | 4 pass/0 fail | 8.11s | 0 |
| 2 | patched | `1174399d` | 5.96→6.79 | 4 pass/0 fail | 7.65s | 0 |
| 3 | baseline | `6906ab99` | 6.49→8.35 | 4 pass/0 fail | 8.50s | 0 |
| 4 | patched | `1174399d` | 8.35→8.61 | 4 pass/0 fail | 7.01s | 0 |
| 5 | baseline | `6906ab99` | 8.32→9.02 | 4 pass/0 fail | 6.97s | 0 |
| 6 | patched | `1174399d` | 8.38→9.39 | 4 pass/0 fail | 7.43s | 0 |

6回全てPASS。baseline平均7.86s、patched平均7.36s(patchedの方が僅かに速い)。`--reporter=junit`で対象テスト個別の実測msも取得: baseline平均2026ms、patched平均2106ms(差0.08s、baseline自身のばらつき0.68sより小さい)。10秒閾値に対し両側とも約4.8倍のマージン。

**フェーズ別コスト参考値(Phase 9B固有ユニットの限界コスト。⚠️v5内部レビュー(Performance Reviewer)指摘により「計測値」から「参考値」へ改称)**: 各行はn=1で分散の報告がなく、3行のうち2行はpatchedがbaselineより速いという結果になっており、これはこの検証環境(swapを多用するメモリ逼迫状態、§3-9-g参照)のノイズ床が信号を上回っている徴候である。結論を実際に支えているのはn=3のファイルレベル計測(§3-9-f/§3-9-g)であり、方向性は一致するため調査の再開は求めないが、Phase 9Cで接続あたりの防御可能な数値が必要な場合は反復測定と静穏なマシンでの再計測が必要。

| フェーズ | baseline(v124) | patched(v125) | 差分 |
|---|---|---|---|
| PGLite connect(fresh) | 1245.9ms | 1154.6ms | −91ms |
| `initSchema()`全体 | 583.2ms | 570.1ms | −13ms |
| **最終migrationステップ単体** | 2.4ms(baseline側は`migrate.ts`にv125エントリ自体が存在しないため、実際にはv123→v124の計測値) | 2.0ms(v124→v125、Phase 9B自体の計測値) | 単純比較不可(別マイグレーション同士) |

**⚠️v5内部レビュー(Documentation Reviewer)で訂正**: 上記表の最終行は当初「v124→v125 migrationステップ単体」「差分 −0.4ms」としていたが誤りだった。baseline worktreeは`migrate.ts`がv124までしか持たないため、baseline側の2.4msは実際にはv123→v124(`page_search_vector_drop_compiled_truth`)の計測値であり、v124→v125と直接比較できる数値ではない。**結論自体(v125 migration自体の限界コストは約2ms、報告された異常(baseline比約19,000ms)の説明には4桁不足する)はpatched列単独の数値で支持されており変わらない。**

**⚠️v5内部レビュー(Performance Reviewer)で補足**: 上記の論証(桁の乖離)自体は正しいが、根拠として引用している「約2ms」はv125 migrationステップ単体という狭い量であり、Phase 9Bがエンジン起動ごとに追加する他の経路(bootstrapプローブのEXISTSサブクエリ3件、スキーマblobの追加DDL4文)を捉えていない。より強い根拠は同じ表の`initSchema()`全体の行(baseline 583.2ms対patched 570.1ms、patchedの方が速い)であり、こちらがPhase 9Bの接続あたり全体デルタを測定ノイズ以下に抑え込んでいる。結論(4桁の乖離をPhase 9Bでは説明できない)は変わらないが、根拠としてはこちらの方が正確である。

**交絡因子の直接再現(baseline側、Phase 9Bコード変更ゼロ)**: このファイルの`bun test`を`SHARD`未設定のまま8並列実行(shard負荷を模擬)。**baseline worktree(`6906ab99`、Phase 9Bコード皆無)で実施**:

```
uptime BEFORE: load averages: 6.34 6.25 5.73
uptime AFTER:  load averages: 89.70 28.99 14.22
```
**⚠️v5内部レビュー(Documentation Reviewer)で発見**: 上記uptime引用を裏付ける生ログファイルはバンドル内に同梱されていない(`contention-baseline/proc-*.log`はbunの標準出力のみでuptime行を含まない)。実験自体(8並列実行で報告失敗シグネチャが8/8再現)は`contention-baseline/proc-*.log`で確認できる直接証拠付きだが、この特定のuptime数値は本文にのみ存在し追加の裏付けはない旨を明記する。実験結論(8並列で約8.7倍の減速、baseline/patched双方で同程度の感受性)自体は`contention-baseline/`・`contention-patched/`配下の生ログで独立に確認可能。

8プロセス全てで同一テストが失敗(3 pass/1 fail)、実測16646.95〜18321.69ms(平均17569ms)。**patched(`1174399d`)でも対称実行し8/8失敗、平均18608ms。** 両側とも8並列で約8.7〜8.8倍の減速(baseline: 17569/2026≈8.67倍、patched: 18608/2106≈8.84倍)が発生し、感受性は同一。

**判定: B** — v3のdirect実行検証手法(`SHARD`未設定でshard相当の並列負荷をかけた)自体が交絡因子であり、Phase 9Bはこの失敗の原因ではない。baseline(Phase 9Bコードゼロ)で同一の失敗シグネチャを条件操作のみで再現できたことが決定的証拠。

#### 3-9-g. v4 — `page-search-vector-overflow.test.ts` #2704の失敗: 原因調査と直接証拠

**症状(v3のdirect実行ログで発見)**: `test/page-search-vector-overflow.test.ts` の `#2704: oversized page body no longer overflows pages.search_vector > an oversized page is still keyword-searchable via chunk-grain search after import` が、shard2のdirect実行ログでのみ42121.32ms(タイムアウト30000ms)で失敗。baseline/patched双方の`run-unit-parallel.sh`経由full-suiteログには一切出現しない(後述3-9-i)。

**調査は専門サブエージェント(v4-agentB-pagesearch)へ委譲した。**

**根本原因(3-9-fとは異なるメカニズム)**: 30000msはCLIの`--timeout`フラグではなく、**テストファイル自身がbunの`test()`第3引数として持つper-testタイムアウト**(`}, 30_000);`、該当ファイル78-80行)。この上限は`SHARD`環境変数に依存せず無条件で、`scripts/run-unit-shard.sh`が渡す`--timeout=60000`より優先される(bunのper-test第3引数がCLIフラグに優先することを、別途作成した再現用テストで実証確認済み)。したがってv3報告書中の「`--timeout=60000`を渡した」という記載自体は誤りではないが、この失敗の説明には無関係だった。`SHARD`依存の閾値切替ロジックはこのファイルには存在しない(grep 0件、`test/helpers/reset-pglite.ts`・`src/core/pglite-engine.ts`も同様)。

**shard配置の変化の説明(性能とは無関係)**: Phase 9Bがテストファイルを4件追加した結果、ソート済みファイルリストに対するラウンドロビン式shard割当がずれ、対象ファイルはbaselineでshard4・patchedでshard2に位置することになった。これは純粋な組み合わせ上の帰結であり、コードの影響ではない。

**Phase 9Bがこのテストの経路に触れる可能性の直接確認**: `phase9b-code-changes-v4.diff`の追加行を`pages`/`search_vector`/`update_page_search_vector`/`content_chunks`でgrepしたところ**ヒット0件**。v125 migrationが作成するのは`principal_kinds`/`principals`テーブルと`oauth_clients.principal_id`(nullable)+部分Indexのみであり、このテストが読み書きする`pages`/`content_chunks`とは無関係。書込パスにオーバーヘッドが追加される経路は存在しない。

**Step1: 単独実行タイミング(各3回)**:

| Run | Side | HEAD | Exit | ファイル合計 | 対象テスト実測 |
|---|---|---|---|---|---|
| 1 | baseline | `6906ab99` | 0 | 3.55s | 1.016s |
| 1 | patched | `1174399d` | 0 | 2.78s | 0.754s |
| 2 | baseline | `6906ab99` | 0 | 2.80s | 0.768s |
| 2 | patched | `1174399d` | 0 | 2.74s | 0.815s |
| 3 | baseline | `6906ab99` | 0 | 3.01s | 0.789s |
| 3 | patched | `1174399d` | 0 | 2.92s | 0.837s |

全6回`3 pass/0 fail`、exit 0。baseline平均0.858s、patched平均0.802s(patchedの方が僅かに速い)。30秒閾値に対し約35倍のマージン、記録された42121msは隔離時実測の約50倍。テストファイルは両worktreeでMD5完全一致(`a850f238a33986ad3a8fd318fb1b5e82`)。

**交絡因子の再現実験(baseline単独、Phase 9Bコード変更ゼロ)**: 並行`bun test`プロセス数を1→32まで段階的に増やして対象テストの実測時間を計測:

| 並行プロセス数 | 対象テスト実測 | 結果 |
|---|---|---|
| 1 | 0.77–1.02s | 3 pass |
| 8 | 3.66–4.34s | 8/8 exit 0 |
| 16 | 10.4–13.0s | 16/16 exit 0 |
| 24 | 21.0–24.6s(30秒閾値の82%) | 24/24 exit 0(依然PASS) |
| 26 | 一部が60秒hook側で先に失敗(`cN26-exits.txt`: 26プロセス中7つexit=1、`TimeoutError`@66.9s) | 19/26 exit 0、7失敗 |
| 28–32 | プロセス飽和により60秒hook側で先に失敗 | — |

baselineコードのみで、並行度を上げるだけで対象テストの所要時間は0.77秒→24.6秒(約32倍)まで変動した。検証環境(M2 mini、性能コア4、RAM16GB)は静止時点で既にswap 7.17GB中6.27GB使用済みという、メモリ逼迫状態にあることも確認した。30秒という文字通りのタイムアウト到達は測定範囲内では再現できなかった(24並行で82%まで到達も依然PASS)。**⚠️v5内部レビュー(Documentation Reviewer)で訂正**: 「プロセス飽和により60秒hook側で先に失敗し始めるのは28並行以降」という当初の記載は誤りで、実測(`cN26-exits.txt`)によれば**26並行の時点で既に一部(7/26)が60秒hookタイムアウトで失敗している**。上表に26並行の行を追加した。ダイナミックレンジ(約32倍)と全体結論(閾値の文字通りの再現は測定範囲内で不可能だったが原因は資源競合)自体は変わらない。

**判定: B** — Phase 9Bにはこのテストの経路に触れるコード変更が存在せず(diffで確認)、隔離条件ではpatchedの方が僅かに速く、baseline単独でも並行度操作のみで大きな時間変動が生じることを実証した。文字通りの閾値超過の再現は不完全だが、原因がPhase 9Bのコードではなく実行時の資源競合であるという結論は複数の独立した証拠で支持される。

**Phase 9Bスコープ外の副次的指摘(参考、本ラウンドでは対応せず)**: このテストの30秒タイムアウトは、隔離時実測(約0.8秒)に対して現実的な資源競合下では容易に逼迫しうる(24並行時点で82%消費)、本質的にマージンの薄い設計である。同ファイルの`beforeAll`/`afterAll`の60秒予算に合わせて引き上げることを恒久対応として推奨するが、Phase 9Bの変更範囲外であり本バンドルには含めていない。

#### 3-9-h. v4 — `brain-repo-durability.serial.test.ts`再現性の直接再検証

v3報告書(§3-9-c、旧版)は「単体で即座に再実行したところ19 pass/0 failで問題なく成功した」「再実行で即座に解消することがその直接証拠」と記載していたが、**この主張を裏付けるログはバンドルのどこにも含まれておらず、たった1回の再実行結果のみに基づく不十分な検証だった。** v4でこの点を専用に再検証した。

**再実行(patched worktree `1174399d`、単独・`ps aux`でbun testプロセスがないことを確認済み)**:

```
$ bun test --max-concurrency=1 --timeout=60000 test/brain-repo-durability.serial.test.ts
run1: 18 pass / 1 fail  (git push origin HEA... failed、v3で報告した内容と同一のエラーシグネチャ)
run2: 19 pass / 0 fail
run3: 18 pass / 1 fail
```

**baseline worktree(`6906ab99`、Phase 9Bコード変更ゼロ)でも同一手順で実施**:

```
run1: 19 pass / 0 fail
run2: 18 pass / 1 fail  (同一エラーシグネチャ)
run3: 19 pass / 0 fail
```

baseline 1/3回・patched 2/3回、いずれも同一のエラー(ローカルbareリポジトリへの`git push`が`work-<random>`ディレクトリ内で失敗)で発生。このテストの「origin」はネットワーク越しの実リモートではなく、テスト自身が`mkdtempSync`で作成する**ローカルのbareリポジトリ**であり(`git init -q --bare`)、ネットワーク要因はそもそも介在しない。**baseline(Phase 9Bコード皆無)でも同一シグネチャの間欠的失敗が発生することが、この失敗がPhase 9Bと無関係であることの直接証拠である。** 根本原因(ローカルgit操作の一時的なレース)自体の特定はPhase 9Bの範囲外と判断し、これ以上の追求は行っていない。

**判定: A** — baseline/patched双方で同程度に再現する既存の間欠的flaky(pre-existing flake)。v3報告書の「再実行で即座に解消する」という記載は、たまたま1回だけ再実行しPASSした結果を一般化した誤りであり、正しくは「間欠的に失敗する既存のflakyテストで、発生率はbaseline/patched双方で同程度」である。

#### 3-9-i. v4 — baseline/patched failテスト集合の機械的diff(専門サブエージェントv4-agentC-regression-diffへ委譲)

バンドル内の全7ログファイル(baseline wrapper、patched wrapper、patched direct shard1-4、patched direct serial)から`(fail)`行を機械抽出し(抽出件数は各ログのサマリ行の`fail=N`と完全一致することを確認済み — 抽出漏れなし)、`(テストファイル, テスト名)`をキーに集合diffを実施した。

**集合サイズ**: baseline wrapper 15件・patched wrapper 18件・patched direct(shard1-4+serial合算) 18件・全体の和集合21件。

**差分の内訳(機械算出)**:

| 差分 | 件数 | 内容 |
|---|---|---|
| baseline-only(Phase 9Bで解消した既存失敗) | **0件** | — |
| patched-wrapper-onlyだがbaselineに無い | 3件 | `audit-dir-preload.test.ts`3件(v3で原因特定・修正済み、shard4-direct-postfix実行で0件を確認済み) |
| direct実行のみに存在(wrapperには一切出現しない) | 3件 | longmemeval perf gate(3-9-f)、page-search-vector-overflow #2704(3-9-g)、brain-repo-durability(3-9-h) |

baseline wrapperとpatched wrapperで共通する15件は、ファイル名・テスト名・アサーション種別まで完全に一致することを確認済み。**baseline-only(Phase 9Bによって"直った"ように見える既存失敗)は0件** — つまりPhase 9Bがどの既存失敗にも影響を与えていないことも同時に確認された。

さらに、**patched側**のwrapper full-suiteログにおける各shardの`Ran N tests across N files`行が、patched direct実行の同一shardと**バイト単位で一致するテスト数**(3371/3581/3523/3645、いずれも255ファイル)であることを確認した。これは「wrapperログに出現しない」ことが「スキップされた」ではなく「実行され、かつPASSした」ことの直接証拠である(bunの標準reporterはPASSしたテストの個別行を出力しないため、絶対に出現しないテストと実行されてPASSしたテストは、ログの見た目だけでは区別できない。この構造的性質を利用して正しく判定した)。**⚠️v5内部レビュー(Documentation Reviewer)で訂正: 本節は当初「baseline/patched wrapperそれぞれ」で一致すると記載していたが誤りだった。** baseline wrapperの実測shardテスト数(3417/3494/3555/3611、いずれも254ファイル、§3-9-d参照)はpatched direct実行のいずれのshardとも一致しない(baselineはPhase 9B追加前でファイル構成自体が異なるため、原理的に一致しようがない)。上記の「実行されPASSした」という論証はpatched側についてのみ成立し、baseline側の裏付けにはならない。ただしbaseline側については、baseline wrapperのfail集合自体(15件)が直接ログから機械抽出されており(§3-9-i冒頭の集合サイズ参照)、longmemeval/page-search-vector-overflow/brain-repo-durabilityのいずれも含まれていないことは別途確認済みであるため、結論(baseline wrapperにはこれら3件が出現しない)自体は変わらない。

再現可能な成果物: `extract_fails.py`・`diff_fails.py`・`fails.json`(全51件の抽出済み失敗レコード、行番号・実測時間・エラーテキスト付き)。

#### 3-9-j. 結論(v4、§3-9-eを置き換える)

baselineとpatchedのfailテスト集合は、以下の条件下で一致することを機械的diff(§3-9-i)と個別の原因調査(§3-9-f〜h)の両方で確認した:

1. **`run-unit-parallel.sh`経由の通常実行(wrapper)では、v3修正後のpatchedとbaselineのfail集合は完全に一致する**(共通15件、差分0件)。
2. **direct実行特有の追加3失敗(longmemeval・page-search-vector-overflow・brain-repo-durability)は、いずれもPhase 9Bの実装コードとは無関係であることを、baseline側での再現実験を含む直接証拠で個別に確認した。** 内訳: longmemevalは`SHARD`環境変数依存の閾値をdirect実行が正しく設定していなかったことによる誤検出(baseline側でも同一条件で再現)、page-search-vector-overflowはハードコードされたper-testタイムアウトに対する実行時資源競合の感受性(baseline側でも並行度操作のみで大きく変動)、brain-repo-durabilityはbaseline/patched双方で同程度に発生する既存の間欠的flaky。
3. Phase 9Bによって"直った"ように見える既存失敗は0件であり、Phase 9Bが既存テストの挙動に一切影響していないことも確認された。

**ソースコードの修正は不要と判定した。** `phase9b-code-changes-v4.diff`は`phase9b-code-changes-v3.diff`とバイト単位で同一であり、本ラウンドでの実ファイル変更はない。

## 4. ライブサーバ実機テスト(実サーバ・実HTTPリクエスト)

`test-log-03-live-server-smoke-credential-redacted.txt`(バンドル内の実ファイル名。旧記述`test-log-03-live-server-smoke.txt`は訂正)に全文収録。要約:

- フレッシュなPGLiteブレインの新規初期化(`gbrain init --pglite --no-embedding`)
- `gbrain doctor`によるスキーマ健全性確認
- 実際のOAuthクライアント登録(`gbrain auth register-client`)
- 実際のHTTPサーバ起動(`gbrain serve --http`)
- OAuthメタデータ discovery
- client_credentialsグラントによる実トークン発行
- MCP `/mcp` `tools/list`・`tools/call`(`whoami`)の実行
- HTTP `POST /ingest`の実行
- トークン失効(`/revoke`, RFC 7009)と失効後401確認

いずれも実際のHTTPリクエスト/レスポンスで確認済み(モック・シミュレーションではない)。

## 5. 未実施のテストと理由(虚偽報告なし、v2時点)

| 未実施項目 | 理由 | 代替証跡 |
|---|---|---|
| Connector(ChatGPT/Claude Desktop等)からの実接続 | 本環境からそれらの外部クライアントを操作できない(初版から変化なし) | ライブサーバテストでOAuth discoveryメタデータ・MCPプロトコル応答が仕様通りであることを確認済み(Connectorが依拠する契約面)。**(⚠️v5内部レビューで訂正)** 当初「`serve-http.ts`は無変更のため契約面の破壊可能性は低い」としていたが、v5のREQUIRED-Bで`serve-http.ts`のCallToolRequestSchemaハンドラ内の認可判断部分に変更を行った。ただしこれは`authorizeOperation()`への挙動不変の抽出のみ(判定ロジック自体は一切変更していない)であり、OAuth discoveryメタデータ・MCPプロトコル応答の契約面には触れていないため、結論(契約面の破壊可能性は低い)自体は変わらない。これは推測であり実機確認ではないことを明記する |
| CLI全コマンドの網羅的動作確認 | 範囲が広すぎるため個別には未実施(初版から変化なし) | フルUnitスイート(v2: 14094 pass)の多くがCLI隣接コードパスを経由。init/doctor/auth register-client/serveは実機確認済み |

**v2で解消した未実施項目**: Postgres実機テスト(§7で実施)、`release/deploy.serial.test.ts`の個別直接検証(§3-9で実施、推定ではなく直接観測に置き換え済み)。

## 6. git status --short(v2最終)

```
 M src/core/migrate.ts
 M src/core/oauth-provider.ts
 M src/core/operations.ts
 M src/core/pglite-engine.ts
 M src/core/pglite-schema.ts
 M src/core/postgres-engine.ts
 M src/core/schema-embedded.ts
 M src/core/utils.ts
 M src/schema.sql
 M test/schema-bootstrap-coverage.test.ts
?? PHASE9A-AUTHORIZATION-INVARIANTS.md
?? PHASE9A-CURRENT-STATE-AUDIT.md
?? PHASE9A-EVIDENCE-MANIFEST.md
?? PHASE9A-GAP-AND-ROADMAP.md
?? PHASE9A-IDENTITY-MODEL-DECISION.md
?? PHASE9A-SUPPLEMENTAL-AUDIT.md
?? PHASE9A-TARGET-DOMAIN-MODEL.md
?? PHASE9B-IMPLEMENTATION-REPORT.md
?? PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md
?? PHASE9B-MIGRATION-AND-ROLLBACK.md
?? PHASE9B-REVIEW-MANIFEST.md
?? PHASE9B-TEST-EVIDENCE.md
?? test/authorization-invariant-matrix.test.ts
?? test/e2e/principal-postgres.test.ts
?? test/oauth-fallback-pre-phase9b.test.ts
?? test/principal-identity-foundation.test.ts
?? test/principal-rollback-pglite.test.ts
?? test/principal-schema-parity.test.ts
```

本番ソースコードの変更は10件の`M`(すべてPhase 9Bのスコープ内ファイル。v2でREQUIRED-2/4対応により`pglite-engine.ts`・`postgres-engine.ts`・`utils.ts`・`test/schema-bootstrap-coverage.test.ts`の4件が新たにM対象へ加わった)。それ以外は全て新規`??`ファイル(Phase 9A文書7件+Phase 9B報告書5件+新規テスト6件、うち5件はv2で追加)。`src/commands/serve-http.ts`・管理画面・`.claude/settings*`への変更はゼロ(v2でも維持)。

**⚠️v5内部レビューで訂正**: 本節は「v2最終」のスナップショットのまま未更新であり、v5で新たに変更した`src/core/scope.ts`(新規`M`)・`src/commands/serve-http.ts`(新規`M`、直前段落の「変更ゼロ」はv2〜v4時点の記述であり現在は不正確)・`test/e2e/postgres-bootstrap.test.ts`(新規`??`)が反映されていない。最新のgit状態は`PHASE9B-IMPLEMENTATION-REPORT.md`§5(変更ファイル一覧)を正とする。

## 7. REQUIRED-6: Postgres実機検証

**環境**: Docker Desktop起動(既存の他コンテナ(worldmonitor等)には一切触れていない) → `docker compose -f docker-compose.test.yml up -d`(`pgvector/pgvector:pg16`、`localhost:5434`、DB名`gbrain_test`)。

**追加ファイル**: `test/e2e/principal-postgres.test.ts`(新規、`DATABASE_URL`未設定時は既存のe2e規約どおりskip)。

### 実装過程で遭遇し、解決した2件の実装バグ(実機でしか顕在化しなかったもの)

実Postgres検証の過程で、PGLiteでは顕在化しなかった実装上のバグを2件発見・修正した。**これらはgbrainの本番コード(`src/`配下)のバグではなく、いずれもテストコード(`test/e2e/principal-postgres.test.ts`)側の実装ミス**であり、Phase 9Bの本番実装(`src/schema.sql`・`oauth-provider.ts`等)には影響しない。

1. **`.rejects`にbareなpostgres.jsクエリを直接渡すと`bun 1.3.10`のmatcherがデッドロックする**: `await expect(sql\`INSERT ...\`).rejects.toThrow()`という、PGLiteでは正常動作するパターンが、postgres.jsの遅延thenable(bare `Bun.SQL`クエリオブジェクト)を経由するとbunのマッチャー内部でハングすることを実機テストで発見した(`await expect(Promise.resolve(sql\`...\`)).rejects.toThrow()`と`Promise.resolve()`で明示的にラップすることで解消)。再現性のあるbisectionテスト(該当テストを単体実行すると1秒未満で完走、他のテストと連続実行すると無限にハングすることを`-t`フィルタで段階的に切り分けて確認)で原因を特定した。
2. **`PostgresEngine`はプロセス内シングルトン接続を使う**: 同一プロセス内で異なる`database_url`を指定して2つ目の`PostgresEngine.connect()`を呼んでも、内部的に既存接続を再利用してしまう(`"[gbrain] connect() called with a different database_url but a connection already exists. Using existing connection."`という診断メッセージを実機ログで確認)。当初「2つの独立したPostgresデータベースを同時に見る」設計だったfresh/migrated schema parityテストは、この制約と両立しないためPGLite側(`test/principal-schema-parity.test.ts`)と同じ、単一接続での逐次比較方式(fresh初期化→スナップショット→Phase 9Bオブジェクト剥離+バージョン巻き戻し→再初期化→スナップショット→比較)に設計変更した。

いずれもbisection(`-t`フィルタで対象テストを段階的に絞り込み)と`pg_stat_activity`/`pg_locks`の直接照会で原因を実機で特定してから修正しており、推測による修正ではない。

### 実行結果(最終、クリーンな1回実行)

```
$ docker exec gbrain-postgres-1 psql -U postgres -d gbrain_test -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
$ docker exec gbrain-postgres-1 psql -U postgres -c "DROP DATABASE IF EXISTS test_principal_migrated;"
$ DATABASE_URL="postgresql://postgres:postgres@localhost:5434/gbrain_test" bun test test/e2e/principal-postgres.test.ts

  [125] principal_identity_foundation...
  v125: principal_kinds + principals tables added; oauth_clients.principal_id (nullable) added — foundation only, not used in authorization
  [125] ✓ principal_identity_foundation
  120 migration(s) applied
  Pre-v0.21 brain detected, applying forward-reference bootstrap
  Schema version 124 → 125 (1 migration(s) pending)
  [125] ✓ principal_identity_foundation
  1 migration(s) applied

 13 pass
 0 fail
 43 expect() calls
Ran 13 tests across 1 file. [2.08s]
```
**⚠️v2時点の値。v5でREQUIRED-A(#10のテストをON DELETE RESTRICT検証へ書き換え)により46 expect() callsへ増加、§11-1参照(13 pass / 0 fail / 46 expect() calls)。**

`bun run typecheck`はエラー0件。

### カバーした項目(ユーザー指定の最低限リストと対応)

| ユーザー指定項目 | 実機検証内容 |
|---|---|
| fresh schema | `DROP SCHEMA public CASCADE`後の`initSchema()`で5種bootstrap kind・`principals`テーブル・`oauth_clients.principal_id`列+Indexが揃うことを確認 |
| v124→v125 migration | Phase 9Bオブジェクトを剥離し`config.version='124'`に巻き戻した状態から`initSchema()`を再実行、正常にv125へ復帰することを確認(2箇所: 単体テストとschema parityテストの両方で) |
| principal_kinds bootstrap | 5種(human/service/agent/device/unknown)が揃うこと、`ON CONFLICT DO NOTHING`が冪等であることを確認 |
| custom kind | `'robot'`種別をプレーンなINSERTのみで追加できることを確認 |
| FK | `principals.kind_id`への不正な値・`oauth_clients.principal_id`への存在しないPrincipal IDへの参照がいずれも実Postgresで拒否されることを確認 |
| nullable principal_id | 新規登録Clientの`principal_id`がnullで初期化されることを確認 |
| ON DELETE RESTRICT | **⚠️v5内部レビューで訂正**(旧記述は`ON DELETE SET NULL`で「紐付けたPrincipalを削除してもClient行自体は残り、`principal_id`のみNULLになる」だったが、v5でFKを`RESTRICT`へ変更した。現在の正しい検証内容: 紐付けたPrincipalの削除自体が拒否され、Client行・Principal行・監査参照(`mcp_request_log`)のいずれも変更されないことを確認。詳細は§11-1参照) |
| OAuth発行・OAuth検証 | `GBrainOAuthProvider.registerClientManual`→`exchangeClientCredentials`→`verifyAccessToken`の実フローを実Postgresで実行し、トークン発行・検証が機能することを確認 |
| AuthInfo | Principal紐付けあり/なし双方で`principalId`/`principalKind`の解決が正しく行われ、scopeには一切影響しないことを確認。`revoked_at`設定済みPrincipalでも認可結果が不変であることも確認 |
| rollback | `PHASE9B-MIGRATION-AND-ROLLBACK.md`§4-2の手順を実Postgresで実行し(`sql.begin()`による実トランザクションとして、詳細は次項)、version巻き戻し・オブジェクト消失・既存OAuth存続・v125再適用成功を確認 |
| 再migration | rollback後の`initSchema()`再実行、および独立した「migration再実行の冪等性」テストの両方で、bootstrap kindの重複が発生しないことを確認 |

## 8. REQUIRED-7: Rollback実行(PGLite + Postgres)・完全Patch検証

### 8-1. PGLite側

**追加ファイル**: `test/principal-rollback-pglite.test.ts`(新規)

`PHASE9B-MIGRATION-AND-ROLLBACK.md`§4-2に記載した手動rollback SQLを**文字通りそのまま**実行し、以下4点を実測で証明した:

1. 「v125適用→テストデータ作成」: 新規PGLiteエンジンで`initSchema()`実行(v1→v125へ120マイグレーション適用)、Principal付きOAuth Clientを1件登録・トークン発行・`verifyAccessToken()`でprincipalId/principalKindが正しく解決されることを確認(rollback前ベースライン)。
2. 「rollback実行→version=124確認→Phase 9Bオブジェクト不存在確認」: §4-2のSQLブロックを`.exec()`で実行。`config.version`が`'124'`になること、`principal_kinds`/`principals`テーブルが存在しないこと(`to_regclass`で確認)、`oauth_clients.principal_id`列が存在しないこと、`idx_oauth_clients_principal_id`が存在しないこと、さらに`SELECT ... FROM principals`等が実際にエラーになる(カタログ上の不在だけでなく実クエリでも失敗する)ことを確認。
3. 「既存OAuth基本動作確認」: rollback**前**に登録した同一Client(`preExisting.clientId`)で、rollback**後**にトークン発行・検証を再実行し、認証成功・scope不変・`principalId`/`principalKind`がundefinedへ安全に縮退することを確認(`test/oauth-fallback-pre-phase9b.test.ts`で単体検証済みのフォールバック経路を、本物のrollbackを経由して踏むテスト)。
4. 「v125再適用成功確認」: `initSchema()`を再実行し、`config.version`が125以上に戻ること、5種の初期Principal種別が復元されること、rollback前に登録したClientの`principal_id`は(rollbackで破壊されたまま)nullである一方、新規Principal紐付けフローがrollback前と全く同じ結果になることを確認。

**実行結果**:
```
$ bun test test/principal-rollback-pglite.test.ts
 4 pass / 0 fail / 36 expect() calls
```
`bun run typecheck`もエラー0件(本ファイル起因のエラーなし)。

### 8-2. Postgres側

`test/e2e/principal-postgres.test.ts`内の「manual rollback SQL」テストで実施(§7参照)。PGLite側と異なり、postgres.jsはプールされた接続上での生の`BEGIN;...COMMIT;`複数文実行を`UNSAFE_TRANSACTION`エラーで拒否するため(実機で確認)、`sql.begin(async tx => {...})`(postgres.jsが単一の予約接続上で実トランザクションを保証する公式API)を用いて、§4-2の5文を**同じ順序・同じ内容**で実行した。これは「人間が1つのpsqlセッションで同じSQLを実行する」ことの、ドライバレベルでの忠実な等価物である。

検証内容はPGLite側と同一(v125確認→rollback実行→version=124確認→Phase 9Bオブジェクト不存在確認→rollback前登録Clientの認証存続確認→v125再適用成功確認)。実行結果は§7の13 pass/0 failに含まれる。

### 8-3. 完全Patchの検証

`phase9b-code-changes-v2.diff`(追跡済み変更10件+新規テスト6件、Phase 9A/9B報告書類は含まない)を、`git worktree add`で作成した空の一時worktreeに対し:

```
$ git apply --check phase9b-code-changes-v2.diff
$ git apply phase9b-code-changes-v2.diff
```

いずれもエラーなく成功し、Phase 9Bの変更一式(10件のM+6件の新規テストファイル)が完全に再現されることを確認した。REQUIRED-5(§3-9)の検証専用コミット(`ccb076ca`)は、この適用後の状態から作成したものである。**⚠️v5訂正: `git apply`自体は6件の新規テストファイル全てを正しく適用したが、その後のコミット(`ccb076ca`→`1174399d`)には6件中4件しか含まれておらず(原因未特定の作業ミス)、§3-9のフルスイート実測はこの4件のみを含むツリーに対するもの。詳細は§3-9冒頭の注記、および`PHASE9B-IMPLEMENTATION-REPORT.md`§12 REQUIRED-M参照。**

---

## 11. 外部レビュー承認前の内部並列レビュー(v5) — 修正の実測証跡

`PHASE9B-IMPLEMENTATION-REPORT.md`§11に本ラウンドの背景・レビュー結果サマリ・対応方針を記載した。本節はその実測証跡(PGLite・実Postgres双方の生ログ由来の数値)を記録する。

### 11-1. REQUIRED-A: FK `ON DELETE RESTRICT`化

```
$ bun test --max-concurrency=1 --timeout=60000 test/principal-identity-foundation.test.ts
 13 pass / 0 fail / 29 expect() calls  [1.72s]

$ bun test --max-concurrency=4 --timeout=60000 \
  test/principal-identity-foundation.test.ts test/principal-schema-parity.test.ts \
  test/principal-rollback-pglite.test.ts test/authorization-invariant-matrix.test.ts \
  test/oauth-fallback-pre-phase9b.test.ts test/schema-bootstrap-coverage.test.ts
 56 pass / 0 fail / 311 expect() calls  [18.11s]

$ DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
  bun test --max-concurrency=1 --timeout=60000 test/e2e/principal-postgres.test.ts
 13 pass / 0 fail / 46 expect() calls  [2.59s]
```

`test/principal-identity-foundation.test.ts`#10・`test/e2e/principal-postgres.test.ts`の該当テストを、DELETE拒否+client/principal/監査行(`mcp_request_log`)の生存を検証する内容へ書き換えたうえでの結果。`principal-schema-parity.test.ts`のFKアサーション文字列(`...principals.id(SET NULL)`→`...principals.id(RESTRICT)`)も修正。

### 11-2. REQUIRED-B: 認可ゲート抽出(`serve-http.ts`→`scope.ts`)+テストのimport化

```
$ bun run typecheck
$ tsc --noEmit
(エラー0件)

$ bun test --max-concurrency=1 --timeout=60000 test/authorization-invariant-matrix.test.ts
 49 pass / 0 fail / 185 expect() calls  [4.75s]
```
元の21テストに加え、admin scope軸(8状態×3テスト=24)・legacy access_tokens形状1テスト・監査ログ記録1テスト・DCR登録経路2テストを追加した結果(21+24+1+1+2=49)。

### 11-3. REQUIRED-C: `GBRAIN_PGLITE_SNAPSHOT`テスト隔離修正

`principal-schema-parity.test.ts`・`principal-rollback-pglite.test.ts`双方に`delete process.env.GBRAIN_PGLITE_SNAPSHOT`を追加。結果は11-1の56 pass/0 failに含まれる(修正前は本バグの影響下では未検証、修正後の値のみ記録)。**⚠️§12訂正: この`delete process.env.GBRAIN_PGLITE_SNAPSHOT`方式は、その後の§12再レビュー(Testing Reviewer N1指摘)で`engine.connect({ database_path: <一時ディレクトリ> })`を明示指定する方式へ置換されている(env操作なしで同じくsnapshot分岐を無効化)。詳細は§12参照。**

### 11-4. REQUIRED-D: v125マイグレーション`handler`→`sql:`化

```
$ bun test --max-concurrency=1 --timeout=60000 \
  test/principal-identity-foundation.test.ts test/principal-schema-parity.test.ts \
  test/principal-rollback-pglite.test.ts test/authorization-invariant-matrix.test.ts \
  test/oauth-fallback-pre-phase9b.test.ts test/schema-bootstrap-coverage.test.ts
 85 pass / 0 fail / 377 expect() calls  [49.48s]

$ DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
  bun test --max-concurrency=1 --timeout=60000 test/e2e/principal-postgres.test.ts
 13 pass / 0 fail / 46 expect() calls  [2.59s]
```
PGLite・実Postgres双方で、`sql:`文字列化後もv125マイグレーションが正しく適用されることを確認(フレッシュ install・migrated updateの両経路)。**⚠️v5内部レビュー(Documentation Reviewer)で指摘・訂正、§12再レビューでさらに訂正**: 上記のPostgres実行結果は§11-1の3番目のブロックと数値・所要時間(2.59s)まで完全一致しており、REQUIRED-D検証のための別実行ではなく§11-1と同一実行の再掲である。この実行がREQUIRED-D(`migrate.ts`の`handler`→`sql:`化)適用の前後どちらのコード状態で行われたかは、ログの数値だけからは特定できない(時系列の主張はできない)。REQUIRED-Dの効果自体は`PHASE9B-IMPLEMENTATION-REPORT.md`§12でDatabase Reviewerが現行コードに対し独立に再検証済み(実Postgres 19 pass/0 fail/66 expect、PGLite 6ファイル85 pass/0 fail/377 expect)であり、そちらを正とする。

### 11-5. REQUIRED-E〜H: `authorization-invariant-matrix.test.ts`・`oauth-fallback-pre-phase9b.test.ts`の拡充

```
$ bun test --max-concurrency=1 --timeout=60000 test/oauth-fallback-pre-phase9b.test.ts
 9 pass / 0 fail / 43 expect() calls  [21.25s]
```
7状態(baseline・principal_id列欠落・principals欠落(列は残存、新規カバー)・principal_kinds欠落(列/principals残存、新規カバー)・完全pre-v125・pre-v61・pre-v60)+narrowing系2テスト=9。fresh-engine-per-state設計への全面書き換え後の結果。

### 11-6. REQUIRED-I: Postgres bootstrap経路のテストカバレッジ追加

```
$ DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
  bun test --max-concurrency=1 --timeout=60000 test/e2e/postgres-bootstrap.test.ts
 6 pass / 0 fail / 20 expect() calls  [1.48s]
```
既存4テスト+新規2テスト(Phase 9Bオブジェクトのbootstrap復元、bootstrap冪等性)。

### 11-7. REQUIRED-L: 報告書の数値訂正時に再実行した検証

```
$ bun test --max-concurrency=1 --timeout=60000 test/schema-bootstrap-coverage.test.ts
 9 pass / 0 fail / 71 expect() calls  [20.95s]
```
`PHASE9B-MIGRATION-AND-ROLLBACK.md`§2-1の「68 expect() calls」という旧記載を、再実行で得られた実測値71へ訂正する根拠。

```
$ bash scripts/check-privacy.sh; echo $?
0
$ bash scripts/check-proposal-pii.sh; echo $?
0
```
`check:all`(22スクリプト)のうち当初カバーしていなかった先頭2スクリプトを実行し、いずれもOKを確認。

### 11-8. まとめ

全修正について、PGLite側・実Postgres側(Docker、`docker-compose.test.yml`)双方で個別に再実行し、全てPASSを確認した。`bun run typecheck`もエラー0件。REQUIRED-J(ロールバック手順書の順序訂正)・REQUIRED-K(レガシー管理者トークン経路の文書化)・REQUIRED-Lの一部(§3-9関連の記述訂正)はソースコード変更を伴わない文書修正のため、本節には対応する実行ログがない(該当箇所は各ドキュメントの該当節を参照)。

---

## 12. §11修正への再レビュー(第2ラウンド) — 実測証跡

背景・対応方針は`PHASE9B-IMPLEMENTATION-REPORT.md`§12参照。本節はREQUIRED-Oの実測結果を記録する(REQUIRED-M/N/P/Qはドキュメントのみの訂正でありソースコード・テストへの影響がないため、本節に対応する実行ログはない)。

### 12-1. REQUIRED-O: テスト隔離CI lint違反の解消

```
$ bash scripts/check-test-isolation.sh
...
ERROR: test/put-page-remote-auto.test.ts
       rule R1: process.env mutation; use withEnv() or rename to *.serial.test.ts
check-test-isolation: FAIL (1 violation(s))
```
残る唯一の違反(`test/put-page-remote-auto.test.ts`)は本ラウンドで一切変更していない既存の無関係ファイル(`git status`で無変更を確認、直近の変更コミットは`73a1c6e9`)であり、本ラウンドで修正した3ファイル由来の違反は0件。

```
$ bun test test/principal-schema-parity.test.ts
 1 pass / 0 fail / 13 expect() calls

$ bun test test/principal-rollback-pglite.test.ts
 4 pass / 0 fail / 36 expect() calls

$ bun test test/oauth-fallback-pre-phase9b.test.ts
 9 pass / 0 fail / 43 expect() calls
```
いずれも修正前(§11-1・§11-5)と同数のpass/expect() callsを維持しており、構造変更による挙動変化はない。`test/oauth-fallback-pre-phase9b.test.ts`の9テストは修正前と同一の7状態+narrowing系2テストの内訳を保持している。

修正内容: `principal-schema-parity.test.ts`・`principal-rollback-pglite.test.ts`は`delete process.env.GBRAIN_PGLITE_SNAPSHOT`を`engine.connect({ database_path: <mkdtempSyncによる一時ディレクトリ> })`へ置換(`test/enrichment.test.ts`と同じイディオム、`afterAll`で`rmSync`)。`oauth-fallback-pre-phase9b.test.ts`は状態ごとの`test()`直書きを`describe()`+`beforeAll`/`afterAll`構造へ再構成。`scripts/check-test-isolation.allowlist`への新規登録はしていない。

worktreeミラー(`/private/tmp/.../phase9b-verify-worktree/test/`)へも同一の3ファイルを反映し`git add`済み(コミットはしていない)。

### 12-2. Performance Reviewer REQUIRED-1: 冗長JOINの削除

`src/core/oauth-provider.ts`の`verifyAccessToken`クエリから`LEFT JOIN principal_kinds`(FKにより恒真・結果に影響しない冗長JOIN)を削除し、`p.kind_id AS principal_kind`を直接選択する形へ変更。`catch`ブロックの`isUndefinedTableError(err0, 'principal_kinds')`も、このクエリがもう当該テーブルを参照しないため削除(`'principals'`は残置)。

```
$ bun run typecheck
(エラー0件)

$ bun test test/oauth-fallback-pre-phase9b.test.ts
 9 pass / 0 fail / 43 expect() calls

$ bun test test/principal-identity-foundation.test.ts
 13 pass / 0 fail / 29 expect() calls

$ bun test test/authorization-invariant-matrix.test.ts
 49 pass / 0 fail / 185 expect() calls

$ bun test test/oauth.test.ts test/oauth-confidential-client.test.ts \
    test/oauth-authorize-scope-default.test.ts test/oauth-scope-probe.test.ts
 116 pass / 0 fail / 460 expect() calls (4 files)

$ DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
  bun test test/e2e/principal-postgres.test.ts
 13 pass / 0 fail / 46 expect() calls
```

`test/oauth-fallback-pre-phase9b.test.ts`内、「`principal_kinds`テーブル欠落・`principals`+`principal_id`は現存」状態の1テストのみ、期待値を「縮退(undefined)」から「`principals.kind_id`から正常解決」へ意図的に更新した(テスト数・expect数の総計は不変、9 pass/43 expectのまま)。他2状態(`principal_id`列欠落系)は無影響を確認済み。worktreeミラーへ`src/core/oauth-provider.ts`・`test/oauth-fallback-pre-phase9b.test.ts`を反映・staging済み。

あわせて`src/schema.sql`の`principal_id`列にRESTRICTの理由コメントを追加し、`bun run build:schema`で`schema-embedded.ts`を再生成した(挙動不変、コメントのみの差分)。

---

## 13. 最終セルフ監査(§12再レビュー中、Documentation/Performance/Architecture Reviewerがセッション上限到達のため)

§12の再レビュー往復中、review-documentation・review-performance・review-architectureの3エージェントが`You've hit your session limit · resets 7:50am (Asia/Tokyo)`で相次いで失敗し、以降応答不能になった。このうちArchitectureは失敗前に最終確認(REQUIRED=0)を得ていたため影響を受けない。Documentationは最後の応答で新規REQUIRED 3件(§12 REQUIRED-Oの実装方式変更に伴う記述4箇所の残置・Performanceの指摘への対応記録欠落・Performance関連の件数矛盾)を報告した直後に、Performanceは新規REQUIRED-1(冗長JOIN)への対応確認を待っている最中に、それぞれ応答不能になった。

**この2領域について、Sonnet本体が直接セルフ監査・修正し、生きているレビュアーによる再確認は得られていない。** 以下、正直に記録する。

### 13-1. Documentationの最終指摘3件への対応(セルフ検証)

1. `GBRAIN_PGLITE_SNAPSHOT`旧方式記述の残置4箇所 → 全て「§12訂正」注記付きで新方式(`database_path`)へ言及するよう修正済み(`grep -n "delete process.env.GBRAIN_PGLITE_SNAPSHOT" PHASE9B-*.md`で該当6箇所を確認、いずれも訂正注記か旧記述の文脈内引用のみで、無条件の現状記述としての残置はゼロ)。
2. Performanceの指摘への対応記録欠落 → `PHASE9B-IMPLEMENTATION-REPORT.md`§12末尾に「追加: Performance Reviewerの初回報告とREQUIRED-1対応」節、`PHASE9B-TEST-EVIDENCE.md`§12-2を追加済み(`grep -n "冗長JOIN\|恒真" PHASE9B-*.md`で複数ヒットを確認)。
3. Performance関連の件数矛盾 → `PHASE9B-IMPLEMENTATION-REPORT.md`:4・:13の「24件超」「Performanceは0」を「28件」「Performance 1」へ訂正、`PHASE9B-REVIEW-MANIFEST.md`の「受領できておらず」を到着後の実態へ訂正、REQUIRED-Rの記述に「これはレポート到着前のスナップショットである」旨の注記を追加。

### 13-2. Performanceの最終指摘(REQUIRED-1)への対応(セルフ検証)

REQUIRED-1(冗長JOIN)の修正自体は、Performance本人ではなく別の専用サブエージェントが独立に実施・検証したものであり(§12-2参照)、Performance本人による「この修正で問題なし」という最終承認は得られていない。ただし修正内容自体は以下の客観的根拠で裏付けられている: (a) `principals.kind_id`が`TEXT NOT NULL REFERENCES principal_kinds(id)`であることをスキーマから直接確認済みのため、削除したJOINが恒真であったことはPerformance・Architecture・Databaseの3レビュアーが独立に到達した一致結論である、(b) 全影響テストで実測pass/fail/expect数を記録済み(§12-2)、(c) 唯一挙動が変わる1テストケースの新旧アサーションを明示している。

### 13-3. 最終セルフ回帰確認(実施日時点、real repoで実行)

```
$ bun run typecheck
(エラー0件)

$ bun test test/principal-identity-foundation.test.ts test/principal-schema-parity.test.ts \
    test/principal-rollback-pglite.test.ts test/authorization-invariant-matrix.test.ts \
    test/oauth-fallback-pre-phase9b.test.ts test/schema-bootstrap-coverage.test.ts \
    test/oauth.test.ts test/oauth-confidential-client.test.ts \
    test/oauth-authorize-scope-default.test.ts test/oauth-scope-probe.test.ts
 201 pass / 0 fail / 837 expect() calls (10 files) [36.18s]

$ DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
  bun test test/e2e/principal-postgres.test.ts test/e2e/postgres-bootstrap.test.ts
 19 pass / 0 fail / 66 expect() calls (2 files) [1.91s]
```

`ON DELETE SET NULL`・`delete process.env.GBRAIN_PGLITE_SNAPSHOT`・「v3で訂正」誤記のいずれについても、全`PHASE9B-*.md`をgrepし、無条件の現状記述としての残置がないことを機械的に確認した(該当箇所は全て訂正注記か歴史的引用のみ)。

### 13-4. 未解消のまま残る唯一の限界

**review-documentation・review-performanceからの「修正後REQUIRED=0」というライブでの最終承認は、セッション上限のため得られていない。** 上記13-1〜13-3のセルフ検証で客観的根拠は揃えたが、これは独立第三者レビュアーによる承認とは性質が異なる。ユーザーには、この制約を最終完了報告で明示する。両エージェントは翌朝(Asia/Tokyo 7:50am)以降にセッション再開可能になるため、追加確認が必要な場合は別途依頼できる。
