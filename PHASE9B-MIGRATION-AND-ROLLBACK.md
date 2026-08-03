# Phase 9B — マイグレーション証跡・ロールバック手順

**日付**: 2026-08-01(初版) / 2026-08-01(v2、外部レビューREQUIRED-2/6/7対応版) / 2026-08-02(v3、内部並列レビュー(Migration Reviewer)対応版) / 2026-08-02(v4、Migration Reviewer再レビューでの追加指摘対応版) / 2026-08-02(v5、外部レビュー「未承認・REQUIRED 3件」への対応版。本ファイルの独立バージョンカウンタでのv5であり、他ファイルの「v7」と同一ラウンドを指す)
**対象マイグレーション**: `migrate.ts`の`version: 125`, `name: 'principal_identity_foundation'`

**v2改訂**: §3を実Postgres検証結果で更新、§4-2のロールバックSQLは**手順の提示に留まらず実際に実行**した(§4-5、新設)。REQUIRED-2対応(fresh schema正本へのIndex追加+`applyForwardReferenceBootstrap`拡張)は本ファイルの§1が既に記述するマイグレーション内容自体は変更しないため(移行先の最終形は無変更、fresh-install時の到達経路のみ変更)、§1は初版のまま保持する。

**v3改訂**: 外部レビュー承認前にユーザー指示で実施した内部並列レビュー(Migration Reviewer)が、§4のロールバック手順が**手順どおりの順序で実行すると自己復元(自己無効化)する**重大な欠陥を発見した — 4-2(SQLロールバック)を4-3(コードロールバック)より先に実行する構成になっており、Phase 9Bコードが稼働したままSQLだけを実行すると次回のgbrainプロセス接続時に`initSchema()`が全objectを再作成してしまう。§4冒頭に警告と正しい実行順序(全プロセス停止→4-3コードロールバック→4-2SQL実行)を追加し、4-1に停止確認手順を追加、4-4の「既存データは一切変更されない」という記述が`principal_id`の紐付け自体には当てはまらない(再migrationしても復元不可)ことを訂正した。加えて、v125マイグレーション自体を`handler`から`sql:`文字列へ変更した(REQUIRED、Migration Reviewer) — 純粋SQLにも関わらずhandler経由だったため、本番マイグレーション実行時の3回リトライ・statement_timeout上書き・57014診断メッセージという安全機構を全てバイパスしていた。§1のマイグレーション内容自体(最終的なスキーマ形状)は無変更のため§1は既存のまま保持する。

**v4改訂**: Database Reviewer指摘により`oauth_clients.principal_id`のFKを`ON DELETE SET NULL`から`ON DELETE RESTRICT`へ変更した(Principal削除時にaudit属性参照を無言で破壊しないため)際、本ファイルの§4(ロールバック手順)は追随して訂正したが、§1(マイグレーション内容)・§3(Postgres実機検証範囲)の該当行が旧記述`ON DELETE SET NULL`のまま取り残されていた。Migration Reviewerの再レビューで指摘され、§1(4番目の項目)・§3(Postgres検証範囲の記述)の2箇所を`ON DELETE RESTRICT`へ訂正した。あわせて§4-1に「`principals`個々の行を直接削除したい場合はRESTRICTのため先に`oauth_clients.principal_id`をNULL化する必要がある」旨の運用上の注記を追加した(コード変更は不要、ドキュメントのみの訂正)。

同じ再レビューラウンドでArchitecture/Testing Reviewerから「FKをRESTRICTへ変更した際、既にv125(SET NULL版)を本番適用済みの永続ブレインには反映されず、修復経路(v126追加等)が存在しないのではないか」という懸念が提起された。Database Reviewerが`git show origin/master:src/core/migrate.ts | grep -c "version: 125"` → `0`を実証し、v125マイグレーション自体が本番`master`ブランチへ一度もマージされていないこと(この検証作業専用の一時ブランチにのみ存在すること)を確認したため、v126の追い修正は不要と判断した。詳細な根拠・判断は`PHASE9B-IMPLEMENTATION-REPORT.md`§12 REQUIRED-N参照。**将来v125がリリースされる時点のFK定義は最初からRESTRICTであるため、この懸念は再発しない。**

---

## 1. マイグレーション内容

`src/core/migrate.ts`のMIGRATIONS配列に追加した`version: 125`エントリは以下を実行する(全てIF NOT EXISTS / ON CONFLICT DO NOTHINGで冪等):

1. `CREATE TABLE IF NOT EXISTS principal_kinds (id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT)`
2. `INSERT INTO principal_kinds (...) VALUES (5行) ON CONFLICT (id) DO NOTHING` — human/service/agent/device/unknown
3. `CREATE TABLE IF NOT EXISTS principals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kind_id TEXT NOT NULL DEFAULT 'unknown' REFERENCES principal_kinds(id), display_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ)`
4. `ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT`
5. `CREATE INDEX IF NOT EXISTS idx_oauth_clients_principal_id ON oauth_clients(principal_id) WHERE principal_id IS NOT NULL`

これと同一構造が`src/schema.sql`(Postgres正本)・`src/core/pglite-schema.ts`(PGLite正本、手動同期)にも新規インストール向けにインライン定義されており、`src/core/schema-embedded.ts`は`bun run build:schema`で`schema.sql`から再生成した(手編集していない)。

## 2. 実行済みの検証(実際のコマンドと結果)

### 2-1. マイグレーション実行そのものの検証

`test/schema-bootstrap-coverage.test.ts`(既存テスト、フレッシュPGLiteに対して`initSchema()`相当のフルマイグレーション replay を実行する)を実行し、以下を実機確認した:

```
$ bun test test/schema-bootstrap-coverage.test.ts
...
  [124] page_search_vector_drop_compiled_truth...
  [124] ✓ page_search_vector_drop_compiled_truth
  [125] principal_identity_foundation...
  v125: principal_kinds + principals tables added; oauth_clients.principal_id (nullable) added — foundation only, not used in authorization
  [125] ✓ principal_identity_foundation
  120 migration(s) applied

 9 pass
 0 fail
 71 expect() calls
```
(**⚠️v5内部レビューで訂正**: 当初「68 expect() calls」と記載していたが、v2でREQUIRED_BOOTSTRAP_COVERAGEへ3エントリ追加した結果71へ増えており(`PHASE9B-TEST-EVIDENCE.md`§3-6では71に更新済み)、本ファイルのみ旧値のまま残っていた。再実行し71を確認のうえ訂正した。)

これは version 1(実質空)からversion 125まで、既存の全124マイグレーション+新規v125を連続実行し、エラーゼロで完走したことを意味する。v125が既存マイグレーション群と衝突なく実行できることの直接的な実機証拠である。

### 2-2. 新規DB初期化(フレッシュスキーマreplay)の検証

`test/oauth.test.ts`・`test/oauth-confidential-client.test.ts`・`test/oauth-authorize-scope-default.test.ts`・`test/oauth-scope-probe.test.ts`(計116テスト)は、いずれも`db.exec(PGLITE_SCHEMA_SQL)`によるフレッシュスキーマreplay(マイグレーションではなく、`pglite-schema.ts`のインライン定義を直接実行する経路)を`beforeAll`で実行してからテスト本体を走らせる。今回の変更後にこの116テストが全てパスしたことは、フレッシュインストール時に`principal_kinds`(5行ブートストラップ含む)・`principals`・`oauth_clients.principal_id`が正しく作成され、既存のOAuthクライアント登録・トークン発行・検証フローと共存できることの実機証拠である。

```
$ bun test test/oauth.test.ts test/oauth-confidential-client.test.ts test/oauth-authorize-scope-default.test.ts test/oauth-scope-probe.test.ts
...
 116 pass
 0 fail
 460 expect() calls
```

### 2-3. 静的整合性チェック

```
$ bash scripts/check-search-path.sh
OK: all trigger functions in schema base files pin search_path

$ bash scripts/check-jsonb-pattern.sh
OK: no JSON.stringify(x)::jsonb interpolation pattern in src/
OK: max_stalled defaults are 5 in all schema sources
check-jsonb-params: clean

$ bash scripts/check-admin-scope-drift.sh
[check-admin-scope-drift] ok: 6 scopes match
```

### 2-4. 型チェック

```
$ bun run typecheck
$ tsc --noEmit
```
(出力なし = エラーなし)

## 3. PGLite / Postgres 両対応の検証範囲と限界

- **PGLite**: 上記2-1・2-2は全て実際のPGLite(WASM版Postgres)インスタンス上で実行済み。
- **Postgres(v2で解消)**: 初版はdockerデーモン未起動によりPostgres実機検証が未実施だった。v2ではDocker Desktopを起動し、`docker-compose.test.yml`の使い捨てPostgres(`pgvector/pgvector:pg16`, `localhost:5434`, DB名`gbrain_test`)に対して`test/e2e/principal-postgres.test.ts`(新規)を実行し、fresh schema・v124→v125移行・5種bootstrap kind・custom kind追加・FK制約・`principal_id` nullable・`ON DELETE RESTRICT`・fresh/migrated schema parity・OAuth発行/検証・AuthInfo・rollback・再migrationの全項目を実機で確認した(13 pass / 0 fail / 43 expect() calls、詳細は`PHASE9B-TEST-EVIDENCE.md`§7。**⚠️v2時点の値。v5でRESTRICT検証への書き換えにより46 expect() callsへ増加、同ファイル§11-1参照**)。
  - 検証過程で、PGLite側では顕在化しなかった2件のテストコード側の実装バグ(bunのmatcherと`postgres.js`の遅延thenableの相互作用、`PostgresEngine`のプロセス内シングルトン接続)を発見・修正した。詳細は`PHASE9B-TEST-EVIDENCE.md`§7参照。いずれも本番コード(`src/`配下)の問題ではない。
  - `access_tokens`テーブルとの構文パターン一致(初版で述べた類推)は、v2の実機検証によって**確認**に格上げされた。

## 4. ロールバック手順(手動SQL — down migrationの仕組みは本リポジトリに存在しないため新設しない)

`migrate.ts`にはバージョン番号によるup-onlyのマイグレーション機構のみが存在し、down migrationの標準機構は確認できなかった(既存の124件のマイグレーションいずれにも`down`相当のフィールドは存在しない)。したがって新たな自動ロールバック機構を追加せず、以下の手動SQLを証跡として提示する。

> ⚠️ **【内部レビュー(Migration Reviewer)で発見・本ファイルのv3改訂で訂正(注: 他ファイル(`PHASE9B-IMPLEMENTATION-REPORT.md`等)ではこの同一ラウンドを共通の「v5」ラベルで呼んでいるが、本ファイルは独自のv1〜v4バージョンカウンタを使用しており、本ファイル内の「v3」は他ファイルの「v3」(別の異なるラウンド)ではなく、他ファイルの「v5」と同一ラウンドを指す)】実行順序を誤ると、このロールバックは数秒以内に自己復元(自己無効化)する。**
>
> Phase 9Bのコードが稼働したまま4-2のSQLだけを実行すると、gbrainプロセスが次に接続した瞬間(launchdサービス・MCPセッション・cron/dreamサイクル・単発の`gbrain status`実行、いずれでも発生する)に`hasPendingMigrations()`が`config.version=124 < 125`を検知し、`initSchema()`が走る。すると`applyForwardReferenceBootstrap()`の`needsPrincipalIdBootstrap`分岐が`principal_kinds`/`principals`/`oauth_clients.principal_id`を(5件のseed行含め)そのまま再作成し、SCHEMA_SQLのreplayが`idx_oauth_clients_principal_id`を再作成し、`runMigrations`がv125を再適用して`config.version`を`'125'`へ戻す。**運用者が気づかないまま、実施したはずのロールバックが跡形もなく消える。**(この挙動自体は`test/principal-rollback-pglite.test.ts`の「rollback is reversible」テストで意図的に実証済み — ロールバックが打ち消されること自体は仕様どおりだが、それを「気づかず」にやってしまうことが本項の問題)
>
> **したがって、以下の順序を厳守すること(4-3のコードロールバックを4-2のSQL実行より先に行う):**
>
> 1. **全gbrainプロセスを停止する**(launchd管理のサーバー・MCPセッション・cron/dreamサイクル等すべて)。`SELECT count(*) FROM pg_stat_activity WHERE datname = '<対象DB名>'`で接続が残っていないことを確認する。
> 2. **4-3のコード側ロールバックを先に実施し、デプロイする**(Phase 9Bを含まないコードに戻す)。
> 3. **その後で4-2のSQLを実行する。**
> 4. 必要ならサービスを再起動する。
>
> Phase 9Bのコードが稼働したまま4-2だけを単独実行することは、実質的に何も戻さない自己無効化操作である。

### 4-1. 適用条件(必ず確認すること)

- **全gbrainプロセスを停止済みであること**(launchd管理のサーバー・MCPセッション・cron/dreamサイクル等すべて)を`SELECT count(*) FROM pg_stat_activity WHERE datname = '<対象DB名>'`で確認する。これを飛ばすと上記警告のとおりロールバックが自己復元する。
- 対象データベースの`config`テーブルの`version`が**125であること**(それより後のマイグレーションが本番適用されていないこと)を先に確認する。
  ```sql
  SELECT value FROM config WHERE key = 'version';
  ```
- 実行前に対象データベースの完全バックアップを取得する。
- **`principal_id`が設定済みのクライアントがあれば、実行前に一覧をダンプしておく**(4-4参照 — この紐付けはロールバック後、v125を再適用しても復元されない永続的なデータ消失になるため)。
  ```sql
  SELECT client_id, principal_id FROM oauth_clients WHERE principal_id IS NOT NULL;
  ```
- 本番データベースに対して直接適用しない。ステージング環境またはバックアップからのリストア先で先に検証する。
- **(v4で追加、Migration Reviewer指摘)** `oauth_clients.principal_id`のFKは`ON DELETE RESTRICT`のため、上記ロールバックSQL(4-2)とは別に`principals`の個々の行を直接`DELETE`で整理したい場合は、先に`UPDATE oauth_clients SET principal_id = NULL WHERE principal_id = '<対象principal_id>'`で参照を外してからでないと削除は拒否される(4-2のロールバックSQL自体は列ごとDROPするため、この制約の影響を受けない)。
- **(v5で追加、Phase 9C導入に伴う訂正)** Phase 9C(`audit_events`、migrate.ts v126〜v128)は`audit_events.principal_id → principals(id) ON DELETE RESTRICT`というFKを新設した。`config.version >= 126`の場合(=Phase 9Cが適用済みの場合)、`principals`は`audit_events`から参照されているため、下記4-2のSQLをそのまま実行すると`DROP TABLE principals`が`2BP01`(dependent objects exist)で失敗する。この場合は、4-2の前に**Phase 9Cのロールバック(`PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md` §6、`audit_events_attribution_gaps`/`audit_events_compat`ビュー→`audit_events`→登録表3つ→`config.version`を125へ)を先に完了させてから**4-2を実行すること(新しいレイヤーから順に戻す、という一般原則。Phase 9C自身のロールバック手順も同じ原則でv127→v126の順に書かれている)。`config.version`が125のままの環境(Phase 9C未適用)では、この節は無関係であり4-2は従来どおりそのまま実行できる。

### 4-2. ロールバックSQL(実行順序厳守)

```sql
BEGIN;

-- 0. (v5で追加) config.version >= 126 の場合、Phase 9Cのロールバックを
--    先に完了させてから本SQLを実行すること(上記4-1の追記・警告参照)。
--    未完了のままでは次のDROP TABLE principalsが2BP01で失敗する。

-- 1. oauth_clientsからFK列を削除(principalsテーブルへの依存を先に断つ)
ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id;

-- 2. 念のためインデックスを個別にも削除(列削除で自動的に削除されるはずだが明示)
DROP INDEX IF EXISTS idx_oauth_clients_principal_id;

-- 3. principalsテーブルを削除(principal_kindsへの依存を先に断つ)
DROP TABLE IF EXISTS principals;

-- 4. principal_kindsテーブルを削除
DROP TABLE IF EXISTS principal_kinds;

-- 5. スキーマバージョンを125→124に巻き戻す
--    (これより後のマイグレーションが存在しないことを4-1で確認済みの場合のみ)
UPDATE config SET value = '124' WHERE key = 'version';

COMMIT;
```

### 4-3. コード側のロールバック(⚠️4-2のSQL実行より先に、かつ全プロセス停止後に実施すること — 上記警告参照)

以下のコード変更を`git revert`または手動で元に戻し、**先にデプロイしてから**4-2のSQLを実行する:

- `src/schema.sql` — principal_kinds/principals CREATE TABLE + oauth_clients.principal_id列を削除
- `src/core/pglite-schema.ts` — 同上
- `src/core/schema-embedded.ts` — `bun run build:schema`を再実行して`schema.sql`から再生成(手編集しない)
- `src/core/migrate.ts` — version 125エントリを削除
- `src/core/operations.ts` — `AuthInfo`の`principalId`/`principalKind`フィールドを削除
- `src/core/oauth-provider.ts` — `verifyAccessToken`のprincipal関連の射影(`p.kind_id AS principal_kind`。**⚠️v7訂正**: 旧記述は「principal関連JOIN」だったが、v5のREQUIRED-1で`principal_kinds`へのJOINは既に削除済みのため現状は直接選択のみ)・フォールバック分岐・返り値フィールドを削除(v2で追加した`isUndefinedTableError`のnarrowing呼び出しも含む)
- `test/principal-identity-foundation.test.ts` — 削除
- **(v2で追加)** `src/core/pglite-engine.ts`・`src/core/postgres-engine.ts` — `applyForwardReferenceBootstrap()`の`needsPrincipalIdBootstrap`分岐を削除
- **(v2で追加)** `src/core/utils.ts` — `isUndefinedTableError`の`table`引数を削除(または残しても既存呼び出し元は影響を受けない、完全後方互換のため削除は必須ではない)
- **(v2で追加)** `test/schema-bootstrap-coverage.test.ts` — `REQUIRED_BOOTSTRAP_COVERAGE`の3エントリを削除
- **(v2で追加)** `test/principal-schema-parity.test.ts`・`test/authorization-invariant-matrix.test.ts`・`test/oauth-fallback-pre-phase9b.test.ts`・`test/e2e/principal-postgres.test.ts`・`test/principal-rollback-pglite.test.ts` — 削除
- **(v5で追加、⚠️v7で追記。Documentation Reviewerが本節の欠落を指摘)** `test/e2e/postgres-bootstrap.test.ts` — Phase 9Bのbootstrap検証テスト2件(既存ファイルへの追加分)を削除。**削除しないとロールバック後にPhase 9Bオブジェクトを前提としたアサーションが残り、このファイルのテストが失敗する**(他の新規テストファイルは:164で削除対象だが、この既存ファイルへの追加分だけロールバック手順から漏れていた)
- **(v3で追加、⚠️v7で追記)** `test/minions-shell.test.ts` — `GBRAIN_AUDIT_DIR`の保存/復元修正(§9参照)。Phase 9Bの識別子・認可コードとは独立した既存バグ修正のため**戻す必要はない**(戻すと#2823の趣旨に反する退行が再発する)
- **(v5で追加、⚠️v7で追記)** `src/core/scope.ts`(`authorizeOperation()`の追加)・`src/commands/serve-http.ts`(その呼び出しへの置換) — いずれも挙動不変の抽出であり、Phase 9Bのスキーマ・型を一切参照しないため**ロールバック時に戻す必要はない**。戻す場合は2ファイルを必ず同時に戻すこと(`serve-http.ts`側だけ戻すと`authorizeOperation`のimportが解決できずビルドが壊れる)

### 4-4. ロールバックの影響範囲

- Phase 9Bはこのマイグレーション以外のいかなるテーブル・機能にも依存を作っていないため、ロールバックの影響はこの変更点自体に閉じる。
- `oauth_clients`の既存列(`client_id`, `scope`, `bound_*`等)・既存データは一切変更されないため、ロールバック後も既存のOAuthクライアント・トークンはそのまま機能する。
- **⚠️内部レビューで指摘・訂正: 「既存データは一切変更されない」は`principal_id`列自体には当てはまらない。** `oauth_clients.principal_id`に設定されていた紐付けは4-2の実行で完全に失われ、**v125を再適用しても復元されない**(`test/principal-rollback-pglite.test.ts`が`principal_id IS NULL`を再適用後のアサーションとして実測済み)。4-1の事前ダンプが唯一の復旧手段。

### 4-5. ロールバックSQLの実行結果(v2、手順の提示に留まらず実際に実行した証跡)

初版では上記4-2のSQLは「提示」のみで、実行検証はしていなかった。v2では以下2環境で**実際に実行**した。

**PGLite**(`test/principal-rollback-pglite.test.ts`、新規):
```
$ bun test test/principal-rollback-pglite.test.ts
 4 pass / 0 fail / 36 expect() calls
```
4-2のSQLを`.exec()`で文字通り実行し、v125適用→テストデータ作成(OAuth Client+Principal紐付け)→rollback実行→`config.version`が`'124'`になること→`principal_kinds`/`principals`テーブルおよび`oauth_clients.principal_id`列・`idx_oauth_clients_principal_id`が実際に消失していること(カタログ照会+実クエリの両方で確認)→rollback前に登録したClientがrollback後も認証成功しscopeも不変であること(principalId/principalKindのみundefinedへ縮退)→`initSchema()`再実行でv125が完全復元されること、を全て実測した。

**Postgres**(`test/e2e/principal-postgres.test.ts`内、§7参照):
postgres.jsはプールされた接続上での生の複数文`BEGIN;...COMMIT;`実行を`UNSAFE_TRANSACTION`エラーで拒否するため(実機で確認)、`sql.begin(async tx => {...})`(postgres.jsが単一の予約接続上で実トランザクションを保証する公式API)経由で4-2の5文を同じ順序・同じ内容で実行した。検証内容・結果はPGLite側と同一で、実Postgres(`docker-compose.test.yml`のpgvector/pg16)に対して実測した。

いずれも実データベース(使い捨てインスタンス)に対する実行結果であり、SQLの類推による机上検証ではない。

## 5. 本番DBへの適用状況

**本番DB・稼働中インスタンスへは一切適用していない。** 検証は全て(a)一時的なインメモリPGLiteインスタンス(テスト実行時にプロセス内で生成・破棄されるもの)、(b)`docker-compose.test.yml`が起動する使い捨てPostgresコンテナ(`localhost:5434`、本番からは完全に独立)、のいずれかに対してのみ行った。v2で新たに使用したDocker Postgresコンテナも本タスク専用の使い捨てインスタンスであり、本番DBとは無関係。
