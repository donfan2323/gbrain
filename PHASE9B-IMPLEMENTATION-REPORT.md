# Phase 9B — 実装報告書(Universal Identity Foundation — Principal基盤)

**日付**: 2026-08-01(初版) / 2026-08-01(v2、外部敵対的レビューREQUIRED-1〜7対応版) / 2026-08-01(v3、v2再レビュー指摘対応版) / 2026-08-02(v4、v3再レビュー指摘対応版) / 2026-08-02(v5、外部レビュー承認前にユーザー指示で実施した内部並列レビュー(7専門Reviewer)対応版) / 2026-08-02(v6、§11修正への再レビュー(第2ラウンド)対応版、外部レビュー(ChatGPT)へ提出) / 2026-08-02(v7、外部レビューが「未承認・REQUIRED 3件」と判定、その対応版。独立4エージェント(Documentation/Performance再レビュー・フル回帰・整合性監査)による検証済み)
**状態**: 実装・テスト完了、外部レビューREQUIRED 7件(v2)+再レビュー指摘1件(v3)+再々レビュー指摘1件(v4)へ全対応済み。v5では外部レビューとは別に、内部並列レビュー(Architecture/Security/Database/Migration/Testing/Performance/Documentation)でREQUIRED合計28件(第1ラウンド)+15件(第2ラウンド、§12)=**43件**を発見し全て対応(内訳は§13台帳参照)。v6提出後、外部レビュー(ChatGPT)が「未承認・REQUIRED 3件」と判定し、v7でその3件(Beads状態矛盾・Documentation/Performance独立最終確認・フル回帰再実行)全てに対応済み(§14、独立4エージェントによる検証込み)。**外部レビューによる正式承認は本v7時点でも未確認(再提出待ち)。**
**設計文書の優先順位**(競合時は上位を優先): 1) `PHASE9A-IDENTITY-MODEL-DECISION.md` 2) `PHASE9A-AUTHORIZATION-INVARIANTS.md` 3) `PHASE9A-SUPPLEMENTAL-AUDIT.md` 4) `PHASE9A-CURRENT-STATE-AUDIT.md` 5) `PHASE9A-TARGET-DOMAIN-MODEL.md` 6) `PHASE9A-GAP-AND-ROADMAP.md` 7) `PHASE9A-EVIDENCE-MANIFEST.md` 8) `PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`

**v2改訂の要約**: 初版提出は外部敵対的レビューで「未承認・REQUIRED 7件」と判定された。本v2は7件全てに対応した内容を§8に追記し、§5(変更ファイル一覧)・§6(完了条件チェック)を更新したもの。既存の§1〜§4(実装内容・対象外・Principal失効の意味・実コードと設計文書の差異)は初版から変更なし(設計自体は変更していないため)。

**v3改訂の要約**: v2の実ファイルベース監査で、フルUnit回帰においてpatched側のみに存在する追加失敗3件(`test/audit/audit-dir-preload.test.ts`)が未解消のまま「完全に同じ」と誤記されている点を指摘された。原因を直接調査した結果、**Phase 9Bの実装(`src/`)にもPhase 9Bの新規テストにも起因しない、既存ファイル`test/minions-shell.test.ts`の隔離バグ**(`GBRAIN_AUDIT_DIR`環境変数の保存/復元漏れ)が、既存のシャーディング方式の位置依存性によってPhase 9Bのテストファイル追加後に偶然露呈したものと判明した。ユーザー指定の合格条件に従い、この既存バグを修正し(§9、新設)、修正前後の直接比較・rc=143の直接exit code証拠を`PHASE9B-TEST-EVIDENCE.md`§3-9に追記した。§5(変更ファイル一覧)を更新した。

**v4改訂の要約**: v3の実ログベース監査で、direct shard実行特有の追加失敗2件(`longmemeval-trajectory-routing.test.ts`のperf gate、`page-search-vector-overflow.test.ts` #2704)が未解消のまま「fail集合は一致する」と再び誤記されている点、および`brain-repo-durability.serial.test.ts`の「再実行で解消」という主張に裏付けログがない点を指摘された。3件とも個別に原因調査した結果、**いずれもPhase 9Bの実装コードとは無関係**と判明した(内訳は§10参照)。**ソースコードの修正は不要と判定し、本ラウンドでの実ファイル変更はない**(`phase9b-code-changes-v4.diff`はv3のdiffとバイト単位で同一)。`PHASE9B-TEST-EVIDENCE.md`§3-9に新規節(3-9-f〜3-9-j)を追加し、§3-9-eの誤った結論を訂正した。§10(新設)に本ラウンドの調査過程を記載した。

**v5改訂の要約**: v4提出後、外部レビュー(ChatGPT)の正式承認が確認できていない段階で、ユーザーから「Phase 9Cには着手せず、内部レビューでPhase 9Bを正式完了させる」との明示的指示を受けた。7領域の専門Reviewer(Architecture/Security/Database/Migration/Testing/Performance/Documentation)を並列起動し敵対的レビューを実施した結果、REQUIRED合計28件(Architecture 3・Security 0・Database 2・Migration 3・Testing 8・Documentation 11・Performance 1。**⚠️訂正**: Performanceは配送遅延により当初「未受領」のまま集計し「24件超」と記載していたが、§12でレポートが到着し1件と判明したため28件へ訂正)を発見した。実装・テストの修正が必要な項目はSonnet本体が直接修正し(FKの`ON DELETE SET NULL`→`RESTRICT`変更、認可ゲートの`serve-http.ts`からの抽出、v125マイグレーションの安全機構バイパス修正、テスト隔離バグ修正、複数のテストカバレッジ拡充)、報告書のみの訂正が必要な項目(算術ミス・記述矛盾・未文書化ギャップ等)も全て修正した。PGLite・実Postgres双方で全修正を再検証しPASS確認済み。詳細は§11(新設)。

---

## 1. 実装したもの

### 1-1. `principal_kinds`テーブル(新規)

Principal種別のopen-worldレジストリ。固定CHECK制約ではなく登録テーブル方式(`PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1a確定)。

```sql
CREATE TABLE IF NOT EXISTS principal_kinds (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT
);
```

初期5行(`human`/`service`/`agent`/`device`/`unknown`)を`INSERT ... ON CONFLICT (id) DO NOTHING`で冪等投入。新種別は`INSERT`一つで追加可能、スキーマ変更不要(実機テストで確認済み、後述)。

### 1-2. `principals`テーブル(新規)

```sql
CREATE TABLE IF NOT EXISTS principals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind_id      TEXT NOT NULL DEFAULT 'unknown' REFERENCES principal_kinds(id),
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
```

`id`は既存の`access_tokens.id`と同じ`UUID DEFAULT gen_random_uuid()`パターンを踏襲。Phase 9Bでは削除・失効API共に未実装(下記§3参照)。

### 1-3. `oauth_clients.principal_id`(新規列)

```sql
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_oauth_clients_principal_id ON oauth_clients(principal_id) WHERE principal_id IS NOT NULL;
```

nullable、既定null。**(⚠️v5内部レビューで訂正、旧記述は`ON DELETE SET NULL`だった)** `ON DELETE RESTRICT`によりPrincipal行の削除自体を拒否するため、Client行・Principal行・監査参照(`mcp_request_log`)のいずれも生存する(監査参照破壊防止、AUTHZ-INV要件。詳細は§11 REQUIRED-A)。

### 1-4. `AuthInfo`(`operations.ts`)への加算的フィールド追加

`principalId?: string`・`principalKind?: string`を既存インターフェースの末尾に追加。既存フィールドは無変更。

**`principalKind`の値についての判断(ユーザー指定の検討事項)**: `principal_kinds.id`(安定識別子)を格納し、`label`(表示用)は格納しない。理由:
- 認証・認可コア(将来のPolicy Decision層を含む)で利用される可能性を考慮すると、識別子として不安定な表示文字列を混入させるべきではない。
- `principalKindLabel`のような別フィールドをPhase 9Bで追加することも検討したが、現時点でこの値を実際に消費するコンシューマが存在しないため、必要最小限の原則(`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`)に従い見送った。表示ラベルが必要になった時点で、呼び出し側が`principal_kinds`テーブルを`principalKind`(=id)で引けばよい。
- 結果として「Phase 9Bでは`principalKind`をidとして扱い、表示ラベルは後続Phaseへ送る」という第3の選択肢を採用した。

### 1-5. `oauth-provider.ts`の`verifyAccessToken`拡張

既存の`source_id`/`federated_read`と同じ設計思想(同一クエリのJOINで解決、追加ラウンドトリップなし)で、`c.principal_id`・`pk.id AS principal_kind`を主クエリに追加。既存の3段階フォールバック(pre-v60/v61/v0.34ブレインへの段階的縮退)の**外側**にもう1段のフォールバックを追加し、`principal_id`列またはprincipals/principal_kindsテーブルが存在しない(Phase 9B未適用の)ブレインでは、既存の縮退チェーンへ完全に委譲する(`isUndefinedColumnError`/`isUndefinedTableError`の両方で検知)。

---

## 2. 実装しなかったもの(意図的な対象外)

`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`§3で確定した通り、以下は実装していない:

- 管理画面Principal CRUD(UI/API)
- `/admin/api/principals`
- Principal失効操作(製品機能としての`revoked_at`書き込み)
- 既存Clientへの手動紐付け製品機能
- `mcp_request_log.job_id`(Phase 9Cへ)
- Session/Execution Instance専用テーブル
- Delegation変更・孫委任
- Credential統合・`access_tokens`廃止
- Organization/Tenant
- 管理画面・`.claude/settings*`への変更(**⚠️v5内部レビューで訂正**: 当初は`src/commands/serve-http.ts`もこの対象外リストに含めていたが、v5でこのファイルへの唯一の変更(認可判断2行を`authorizeOperation()`呼び出しへ置換する挙動不変の抽出)を行ったため除外した。詳細は§5・§11 REQUIRED-B参照)

## 3. Principal失効の意味(Phase 9B時点)

`revoked_at`列は存在するが、**Phase 9Bのいかなるコードパスもこの列を読み取って認証・認可判断に使わない**。Client認証・トークン有効性・scope認可は、Principalの状態(存在有無・失効有無)に一切左右されない。実機テストで確認済み(後述§5、AUTHZ-INV-003/004/§1-1b準拠)。

### 3-1. 既知の限界: 一部の認証経路は構造的に帰属不可能(内部レビューで発見・明示)

`AuthInfo`は3箇所で構築される(`src/core/oauth-provider.ts`のOAuthパス、同ファイルのレガシー`access_tokens`パス、`src/mcp/http-transport.ts`のもう1つのレガシーパス)。**Principal帰属(`principalId`/`principalKind`)を持てるのはOAuthパスのみ**であり、2つのレガシーパスにはPrincipalを紐付けるためのカラム自体が存在しない。特にレガシー`access_tokens`経路は`scopes: ['read', 'write', 'admin']`を無条件に返す — つまり**最も強い権限(admin)を持つ呼び出し元が、まさに帰属を持てない呼び出し元でもある**。

これはPhase 9Bの不具合ではなく、`access_tokens`廃止自体を対象外とした本フェーズのスコープ判断(§2「Credential統合・`access_tokens`廃止」)から直接導かれる、意図的で境界の明確な既知の限界である。ただし、Phase 9Cが監査(`mcp_request_log`)とPrincipalを統合する際は、この2つのレガシー経路を「未帰属のOAuthクライアント」と同一のNULLへ畳み込まず、「この認証方式では帰属が構造的に取得不可能」として区別できる設計にする必要がある(でなければ、監査ログ上で「admin操作を誰が行ったか」という問いに対し、レガシートークン経由の操作だけが常に無言で答えられない状態になる)。

---

## 4. 実コードと設計文書の差異(発見した場合の報告)

設計文書とのつき合わせの結果、**実装を文書に無理に合わせるのではなく、以下の判断を行った**箇所が3点ある(初版は1点のみ記載していたが、内部レビューで2点目・3点目が判明した):

- **`principal_kinds`のスキーマ設計**: `PHASE9A-IDENTITY-MODEL-DECISION.md`初版は「固定CHECK制約」を仮の設計として言及していたが、Phase 9Bタスク側の指示(A/B/C/D比較)で正式に「登録テーブル方式(C案)」へ確定していたため、後者(確定済みの上位文書)に従った。矛盾はなく、旧仮説を新しい確定判断が正しく上書きしている状態であることを確認した。
- **⚠️内部レビュー(Documentation Reviewer)で発見、v5で訂正(当初「v3」と誤記していた): 差異はもう1点存在する。** `PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`§2/§4は`principalKind`を「`principal_kinds.label`を解決した文字列」「JOINクエリに`principal_kinds.label`を含める」と記述しているが、実装(`src/core/oauth-provider.ts`)は`principal_kinds.id`(表示用の`label`ではなく安定識別子。**⚠️v7訂正**: 旧記述は`pk.id AS principal_kind`だったが、v5のREQUIRED-1で`principal_kinds`へのJOIN自体を削除し現在は`p.kind_id AS principal_kind`を直接選択している。値の出どころが`principal_kinds.id`であること自体は不変)を返す。`src/core/operations.ts`の`AuthInfo.principalKind`のドキュメントコメントにこの判断理由(表示専用の値を認可隣接構造体へ焼き込まない)が明記されており意図的な判断だが、「実コードと設計文書の差異」を扱う本節がこれを挙げていなかったのは報告漏れである。
- **⚠️v7内部レビュー(Documentation Reviewer)で発見: 差異は3点目も存在する。** `PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`§4は「`src/commands/serve-http.ts`への変更は行わない」と明記しているが、v5のREQUIRED-B(認可ゲートのテスト到達性改善)により同ファイルのCallToolRequestSchemaハンドラを`authorizeOperation()`呼び出しへ置換した(挙動不変の抽出のみ、認可判断ロジック自体は無変更)。設計文書側が意図していたこと(管理画面API追加等の禁止)自体は守られているが、文言レベルでは差異であり、§2:84・§5:121では扱われているものの本節が挙げていなかったのは報告漏れである。**差異は1点ではなく3点。**

---

## 5. 変更ファイル一覧(v2、REQUIRED対応分を含む全量)

| ファイル | 種別 | 変更内容 |
|---|---|---|
| `src/schema.sql` | 変更 | principal_kinds/principals CREATE TABLE、oauth_clients.principal_id列追加。**v2**: `idx_oauth_clients_principal_id`をfresh schema正本へ追加(REQUIRED-2)。**v5(内部レビュー)**: `principal_id`のFKを`ON DELETE SET NULL`→`ON DELETE RESTRICT`へ変更(§11 REQUIRED-A)。**§12**: RESTRICT理由のコメント追加(Architecture Reviewer Note、コメントのみ・挙動不変) |
| `src/core/pglite-schema.ts` | 変更 | 同上(手動同期、DRIFT WARNING規約に従う)。**v2**: 同上Index追加。**v5**: 同上FK変更 |
| `src/core/schema-embedded.ts` | 変更(自動生成) | `bun run build:schema`で`schema.sql`から再生成。手編集なし。**v2**: Index追加分を再生成。**v5**: FK変更分を再生成。**§12**: RESTRICTコメント追加分を再生成 |
| `src/core/migrate.ts` | 変更 | `version: 125, name: 'principal_identity_foundation'`マイグレーション追加(v2で無変更、既に冪等)。**v5**: FKをRESTRICTへ変更。加えて、純粋SQLながら`handler`経由だったため本番マイグレーションの安全機構(3回リトライ・statement_timeout上書き・診断メッセージ)を全てバイパスしていた問題を修正し、5文を`sql:`文字列へ移設・`idempotent: true`を明示(§11 REQUIRED-D) |
| `src/core/operations.ts` | 変更 | `AuthInfo`に`principalId`/`principalKind`追加(v2で無変更) |
| `src/core/oauth-provider.ts` | 変更 | `verifyAccessToken`のJOIN拡張+フォールバック追加。**v2**: `isUndefinedTableError`呼び出しを`principals`/`principal_kinds`限定へ狭小化(REQUIRED-4)。**v5で無変更**。**§12**: 恒真で冗長な`LEFT JOIN principal_kinds`を削除し`p.kind_id`を直接選択、対応する`isUndefinedTableError(err0,'principal_kinds')`分岐も削除(Performance Reviewer REQUIRED-1) |
| `src/core/pglite-engine.ts` | **v2新規変更** | `applyForwardReferenceBootstrap()`に`needsPrincipalIdBootstrap`分岐を追加(REQUIRED-2)。**v5**: FKをRESTRICTへ変更 |
| `src/core/postgres-engine.ts` | **v2新規変更** | 同上(Postgres側)。**v5**: 同上FK変更 |
| `src/core/utils.ts` | **v2新規変更** | `isUndefinedTableError(error, table?)`にoptionalな`table`引数を追加(既存4呼び出し元は完全後方互換、REQUIRED-4) |
| `src/core/scope.ts` | **v5新規変更(内部レビュー)** | `authorizeOperation(scopes, op)`を新規export — `serve-http.ts`の認可判断2行(`requiredScope`算出+`hasScope`呼び出し)を挙動不変のまま抽出したもの。テストスイートが本番の実ゲートをimportして検証できるようにするための純粋な関数分離(§11 REQUIRED-B) |
| `src/commands/serve-http.ts` | **v5新規変更(内部レビュー)** | CallToolRequestSchemaハンドラの認可判断部分を`authorizeOperation()`呼び出しへ置換。**挙動不変の純粋な移動のみ**(`requiredScope`算出+`hasScope`判定のロジック自体は一切変更していない)。それ以外(mcp_request_log記録・SSE配信・dispatch呼び出し)は無変更。これまで「変更禁止領域」としていたファイルへの唯一の変更で、内部レビューでの発見を受けた最小限の対応(§11 REQUIRED-B) |
| `test/schema-bootstrap-coverage.test.ts` | **v2新規変更** | REQUIRED_BOOTSTRAP_COVERAGEへprincipal_kinds/principals/oauth_clients.principal_idの3エントリ追加(REQUIRED-2) |
| `test/principal-identity-foundation.test.ts` | 新規(初版) | Phase 9B専用テスト(13テスト、ユーザー指定10項目全てカバー)。**v5**: #10のテストをON DELETE RESTRICT検証(DELETE拒否+client/principal/監査行の生存)へ書き換え |
| `test/principal-schema-parity.test.ts` | **v2新規** | fresh/migrated schemaの列・Index・FK一致を機械検証(REQUIRED-2)。**v5**: FKアサーションをRESTRICTへ修正、`GBRAIN_PGLITE_SNAPSHOT`未設定化を追加(§11 REQUIRED-C)。**§12**: 上記env未設定化を`engine.connect({ database_path: <一時ディレクトリ> })`明示指定方式へ置換(REQUIRED-O、CI lint違反解消) |
| `test/authorization-invariant-matrix.test.ts` | **v2新規** | Principal状態8種×scope種別の認可不変性を実認可境界で検証(REQUIRED-3)。**v5**: 手写しゲートを`authorizeOperation()`のimportへ置換、`sourceId`/`takesHoldersAllowList`をauthから導出(旧: ハードコード)、監査ログ記録を追加、admin scope軸(8状態×3テスト)・DCR登録経路テストを新規追加(§11 REQUIRED-B/E/F) |
| `test/oauth-fallback-pre-phase9b.test.ts` | **v2新規** | pre-v125/pre-v61/pre-v60フォールバックの直接検証+無関係Table欠落のthrow確認(REQUIRED-4)。**v5**: 単一engine+累積DROPのモノトニック設計をfresh-engine-per-state設計へ全面書き換え、2つの未到達分岐(`isUndefinedTableError(err0,'principals'/'principal_kinds')`)を新規カバー、narrowingテストのアサーションを強化(§11 REQUIRED-G/H)。**§12**: `delete process.env.GBRAIN_PGLITE_SNAPSHOT`廃止に伴い`describe`+`beforeAll`/`afterAll`構造へ再構成(REQUIRED-O)。あわせて`principal_kinds`欠落状態のテストをREQUIRED-1(冗長JOIN削除)後の正しい挙動(成功・kind_id直接解決)へ更新 |
| `test/e2e/principal-postgres.test.ts` | **v2新規** | 実Postgres検証一式(REQUIRED-6、詳細は`PHASE9B-TEST-EVIDENCE.md`§7)。**v5**: ON DELETE RESTRICT検証への書き換え(PGLite版と同様) |
| `test/principal-rollback-pglite.test.ts` | **v2新規** | PGLite側Rollback実行検証(REQUIRED-7、詳細は`PHASE9B-TEST-EVIDENCE.md`§8)。**v5**: `GBRAIN_PGLITE_SNAPSHOT`未設定化を追加(§11 REQUIRED-C)。**§12**: 上記env未設定化を`engine.connect({ database_path: <一時ディレクトリ> })`明示指定方式へ置換(REQUIRED-O、CI lint違反解消) |
| `test/e2e/postgres-bootstrap.test.ts` | **v5新規変更(内部レビュー)** | Phase 9BオブジェクトのPostgres側bootstrap経路(`needsPrincipalIdBootstrap`)を検証するテストケース2件を新規追加。従来PGLite側にしか同等のテストがなく、Postgres側は自動テストカバレッジがゼロだった(§11 REQUIRED-I) |
| `test/minions-shell.test.ts` | **v3新規変更** | `describe('shell-audit: write')`の`afterAll`を無条件`delete process.env.GBRAIN_AUDIT_DIR`から保存値への復元へ修正(§9、既存バグの修正。Phase 9Bの識別子・認可コードとは無関係) |

**v4: 実ファイル変更なし。** 上記一覧はv3から無変更(`phase9b-code-changes-v4.diff`は`phase9b-code-changes-v3.diff`とバイト単位で同一)。v4で発生したのは調査のみで、原因はいずれもPhase 9Bの実装コードとは無関係と判定した(§10)。

**v5(内部レビュー): 上記のとおり実ファイル変更あり。** 外部レビュー承認前にユーザー指示で実施した内部並列レビュー(7専門Reviewer)がREQUIRED合計28件(**⚠️v7訂正**: 当初「24件超」と記載していたが、Performanceの配送遅延分1件を含めた正確な内訳は§11の表を参照)を発見し、そのうち実装・テストの修正を要するものに対応した(§11、新設)。詳細はそちらを参照。

**変更禁止領域について**: `管理画面`・`.claude/settings*`への変更は引き続き一切ない。**`src/commands/serve-http.ts`のみ、v5で内部レビューの発見を受け最小限(認可判断2行を関数呼び出しへ置換する挙動不変の移動のみ)の変更を行った** — v2・v3・v4時点では無変更だったが、v5でこの1点に限り変更禁止方針を明示的に見直した(理由は§11 REQUIRED-B参照)。`git status --short`の実出力は`PHASE9B-TEST-EVIDENCE.md`§6(v7で再取得済み)を正とする。

---

## 6. 完了条件チェック(ユーザー指定18項目)

| # | 条件 | 状態 |
|---|---|---|
| 1 | principal_kinds実装 | ✓ |
| 2 | 初期5種別が冪等投入 | ✓(実機テスト済み) |
| 3 | 未知種別をデータ追加のみで拡張可能 | ✓(実機テスト済み、'robot'種別を追加して確認) |
| 4 | principals実装 | ✓ |
| 5 | oauth_clients.principal_idがnullableで追加 | ✓ |
| 6 | 既存Clientが全てnullのまま動作 | ✓(実機テスト済み) |
| 7 | AuthInfoにPrincipal情報が加算的に追加 | ✓ |
| 8 | Principalあり/なし双方で認証が動作 | ✓(実機テスト済み、ライブサーバでも確認) |
| 9 | Principal種別・失効状態が認可結果を変えない | ✓(実機テスト済み) |
| 10 | 既存OAuth/MCP/HTTP/CLI/Connector互換性維持 | ✓(ライブサーバでOAuth/MCP/HTTP実証、CLI起動確認。Connector実機は環境上未実施、§不足事項参照) |
| 11 | 既存権限・能力が弱められていない | ✓(新規deny/ask/制限を一切追加していない) |
| 12 | Phase 9B対象外機能が実装されていない | ✓(§2参照、grep検証済み。§2記載の`serve-http.ts`例外はREQUIRED-B対応による認可ゲート抽出のみで、対象外機能=管理画面API・CRUD・失効操作のいずれも実装していないことに変わりはない) |
| 13 | PGLite新規初期化・アップグレード成功 | ✓(実機テスト済み) |
| 14 | Postgres確認 | ✓(**v2で解消** — Docker Desktopを起動し実Postgresで検証済み。詳細§8) |
| 15 | 全テスト結果と未実施項目の明示 | ✓(`PHASE9B-TEST-EVIDENCE.md`) |
| 16 | rollback手順の提示 | ✓(`PHASE9B-MIGRATION-AND-ROLLBACK.md`。**v2**: 手順の提示だけでなく実行まで完了) |
| 17 | 本番DBへ変更していない | ✓(v2でも維持。使い捨てDocker Postgresのみ使用) |
| 18 | `.claude/settings*`を変更していない | ✓ |

---

## 7. Beadsタスク・Git状態

- Beadsタスク: `dashboard-vyyod`(Phase 9B: Universal Identity Foundation - Principal基盤実装)— **REVIEW_PENDING状態で維持**。ユーザーの外部レビュー完了まで正式CLOSEDにしない。v2対応後も維持。
- 変更開始前のHEAD SHA: `6906ab9982017133244a18cb72f4a9098d76108d`(branch: master、v1・v2共通、無変更)
- 本タスク中(**⚠️v7訂正**: 旧記述「v1・v2とも」→v1〜v7を通じて)、実working treeへのコミットは実施していない(`git add`/`git commit`いずれも未実行)。ユーザー指示「外部レビュー完了前にBeadsを正式完了としない」「コミットする場合はPhase 9B専用の単一論理コミットにする」に従い、レビュー前のコミットは意図的に見送った。REQUIRED-5/7の検証のみ、一時worktree(`phase9b-required-remediation-verify`ブランチ、実working treeとは完全に別のディレクトリ)内で検証専用コミットを作成しており、実masterには一切影響しない。

---

## 8. 外部レビューREQUIRED-1〜7 対応詳細

外部敵対的レビューは初版提出を「未承認・REQUIRED 7件」と判定した。以下、各項目への対応を要約する(詳細な実行ログ・アサーション数は`PHASE9B-TEST-EVIDENCE.md`参照)。

### REQUIRED-1: Credentialの成果物からの除去
`test-log-03-live-server-smoke-credential-redacted.txt`(バンドル内の実ファイル名。旧記述`test-log-03-live-server-smoke.txt`は訂正)に含まれていた実OAuth Client Secret・Access Tokenを`[REDACTED_*]`へ置換。裏付けとして使ったスクラッチPGLite DB・テストサーバプロセス・OAuth Clientが破棄済みであることを確認し、機械grepで秘密値0件を確認した(`credential-scan-and-destruction-log.txt`に手順を記録、秘密値自体は再掲していない)。

### REQUIRED-2: fresh/migrated schema Index差異の解消
`idx_oauth_clients_principal_id`をfresh schema正本(`schema.sql`/`pglite-schema.ts`/自動生成`schema-embedded.ts`)へ追加。forward-reference crashリスクは、本リポジトリ既存の`applyForwardReferenceBootstrap()`機構を両エンジンで拡張して解消(Indexを削除する判断は取らなかった — 既存の`idx_oauth_clients_source_id`と同じ設計パターンで解決可能だったため)。fresh DB/migrated DBの列・Index・FKが機械比較で完全一致することを実証。

### REQUIRED-3: 認可不変性テストの完全マトリクス化
Principal状態8種(null/human/service/agent/device/unknown/robot(実行時追加)/revoked_at設定済み)×read/write/agent scopeの全組み合わせを、`hasScope()`単体ではなく実Operationハンドラ・実認可境界(`serve-http.ts`が本番で行う2段階ゲートをテスト側で忠実に再現)を通して検証した。**(⚠️v5内部レビューで訂正)** この時点(v2)では「忠実な再現」はテスト側の手写しコードに留まっており、本番の実ゲート関数をimportしてはいなかった。Architecture/Testing Reviewerの指摘を受け、v5のREQUIRED-Bで`serve-http.ts`から`authorizeOperation()`を抽出し、テスト側はこの実関数をimportして検証する方式へ置き換え済み。詳細は§11 REQUIRED-B参照。

### REQUIRED-4: pre-v125フォールバックの直接テスト
`principal_id`列なし/`principals`テーブルなし/`principal_kinds`テーブルなし/pre-v61相当/pre-v60相当の5状態を直接構成し`verifyAccessToken()`を実行、いずれも既存OAuth検証が成功しPrincipal関連フィールドのみundefinedになることを確認。`isUndefinedTableError`の無条件使用はレビュー指摘どおり広すぎたため、`table`引数によるnarrowingを追加し、無関係なTable欠落は握り潰されずthrowされることを直接確認した。

### REQUIRED-5: フルテストの正常完走
一時worktree・検証専用コミットでフルUnitスイートを実行。全shardがbun test自身の完了行(`Ran N tests across N files`)を伴って完走していることを実測確認し、`rc=143`はタイムアウト(124)ではなくシグナル伝播アーティファクトであると判断した根拠を示した。`release/build-release.serial.test.ts`・`release/deploy.serial.test.ts`を個別実行しいずれも直接観測でPASS。Phase 9B適用前のHEADで同一環境・同一コマンドのbaseline実行を行い、失敗する4つのserialファイルがPhase 9B適用前後で完全に同一であることを確認した(Phase 9B起因の回帰が存在しないことの直接証拠)。

### REQUIRED-6: Postgres実機検証
Docker Desktopを起動し、`docker-compose.test.yml`の使い捨てPostgres(pgvector/pgvector:pg16、localhost:5434)に対し、fresh schema・v124→v125移行・5種bootstrap kind・custom kind追加・FK制約・principal_id nullable・ON DELETE RESTRICT(⚠️v5内部レビューで訂正、当時の実装はON DELETE SET NULLだった)・fresh/migrated schema parity・OAuth発行/検証・Principalあり/なしAuthInfo・revoked Principal・migration再評価・rollbackを実機で検証した。

### REQUIRED-7: Rollback実行と完全Patch
PGLite・Postgres両方で、v125適用→テストデータ作成→ドキュメント記載の手動rollback SQLを実行→version=124確認→Phase 9Bオブジェクト不存在確認→既存OAuth基本動作確認→v125再適用成功、という完全なサイクルを実行した。完全Patch(`phase9b-code-changes-v2.diff`)は空の一時worktreeへの適用が`git apply --check`で成功することを確認し、実際に適用してPhase 9Bの変更一式が再現されることを実証した。

---

## 9. v2再レビュー指摘への対応(v3) — フルUnit回帰の未解消分

### 指摘内容
v2のレビューZIPを実ファイルベースで監査した結果、REQUIRED-1〜4・6・7は解消を確認したが、フルUnit回帰について「baselineとpatchedでpatched側のみに3件の追加失敗がある」「報告書の『失敗は完全に同じ』という記述が実ログと一致しない」という指摘を受けた。

### 原因調査

追加失敗3件は全て`test/audit/audit-dir-preload.test.ts`(gbrain#2823のregression gateテスト。Phase 9Bとは無関係の既存ファイル)に集中していた。以下の手順で原因を特定した:

1. 該当ファイルを単体実行 → 3 pass / 0 fail。Phase 9Bのsrc変更自体には起因しないことを確認。
2. `GBRAIN_AUDIT_DIR`環境変数を扱う全テストファイルを`grep`で洗い出し、`test/minions-shell.test.ts`の`describe('shell-audit: write')`ブロックが`afterAll`で**無条件に**`delete process.env.GBRAIN_AUDIT_DIR`していること(元の値を保存せず削除するだけ)を発見。他の同種ファイルは`if (saved === undefined) delete ...; else process.env.X = saved;`という保存/復元パターンを正しく使っており、このファイルだけが例外だった。
3. 最小再現(`bun test test/minions-shell.test.ts test/audit/audit-dir-preload.test.ts`)で、実際に本番failと完全一致する3件の失敗を再現し、さらに実際に操作者の`~/.gbrain/audit/`へテストイベントが漏洩することも確認した(該当ファイルはテスト由来の内容のみで構成されていたため削除して原状回復した)。
4. `scripts/run-unit-shard.sh`のシャーディングアルゴリズム(ソート済み全ファイルリストへの位置ベースmodulo割当)を実際に計算し、Phase 9Bが4件の新規テストファイルを追加したことで、`test/minions-shell.test.ts`の shard 割当が(baselineでは別shardだったものが)patchedでは`test/audit/audit-dir-preload.test.ts`と同じshard 4に変わっていたことを確認した。**Phase 9Bの新規テストファイル自体は`GBRAIN_AUDIT_DIR`を一切参照しない**(grep 0件)。

### 判定
原因はPhase 9Bの実装コードにもPhase 9Bの新規テストの隔離不良にも一切ない。**既存ファイル`test/minions-shell.test.ts`の隔離バグが、既存のシャーディング方式の位置依存性によって偶然露呈したもの**(ユーザー指定の合格条件の分岐でいう「既存ランナーの順序依存」に該当)。

### 対応
ユーザー指定の合格条件「Phase 9Bとの差を解消する」に従い、この既存バグを修正した。`test/minions-shell.test.ts`に`test/subagent-audit.test.ts`と同じ保存/復元パターンを追加し、モジュールロード時点(プリロード適用後)の`GBRAIN_AUDIT_DIR`を保存、`afterAll`で保存値へ復元するよう変更した。

### 検証
- 修正後の最小再現: 43 pass / 0 fail(修正前は3 fail)
- 修正後、patched shard 4の全255ファイルを`scripts/run-unit-parallel.sh`を介さず直接再実行: 3642 pass / 3 skip / 0 fail(修正前は fail=3)
- `bun run typecheck`: エラー0件

詳細な実行ログ・rc=143の直接exit code証拠は`PHASE9B-TEST-EVIDENCE.md`§3-9参照。

---

## 10. v3再レビュー指摘への対応(v4) — direct実行特有の追加2失敗+brain-repo-durability再現性

### 指摘内容
v3のレビューZIPを実ログベースで監査した結果、REQUIRED-1〜4・6・7は解消を確認したが、フルUnit回帰について、patched側のdirect shard実行ログに以下2件のbaseline側には存在しない追加失敗があり、「baselineとpatchedのfail集合は一致する」という報告書の記述が実ログと一致しないという指摘を受けた:

1. `longmemeval-trajectory-routing.test.ts`のperf gate(閾値10000ms、実測約27206.54ms)
2. `page-search-vector-overflow.test.ts` #2704(タイムアウト30000ms、実測約42121ms)

加えて、上記2件と同一条件下でしか観測できない性質の調査(単独条件での複数回比較・二分探索・原因の機械切り分け)を、時間短縮のため並列専門サブエージェントへ委譲するよう指示された。

### 調査方法

3つの独立したサブエージェントに並列委譲した(Sonnet本体は原因分析・統合・最終品質保証を担当):

- **v4-agentA-longmemeval**: longmemevalテストのbaseline/patched単独比較(3回ずつ)、フェーズ別コスト計測、交絡因子の直接再現実験
- **v4-agentB-pagesearch**: page-search-vector-overflowテストの同様の調査
- **v4-agentC-regression-diff**: baseline/patchedの全7ログファイルからの機械的failセットdiff(ログ解析のみ、bun test実行なし)

Agent AとBはいずれも実際に`bun test`を実行する重い調査であり、システム上でのCPU競合を避けるため意図的に**逐次**実行した(Agent Aの完了を待ってからAgent Bを起動)。Agent Cはログ解析のみで`bun test`を実行しないため、Agent Aと並行して起動した。

3エージェントの報告受領後、Sonnet本体が追加で以下を直接実施した: Agent Cが発見した「`brain-repo-durability.serial.test.ts`の『再実行で解消』という記載に裏付けログがない」という指摘を受け、baseline/patched双方で3回ずつの再実行を自ら実施し検証した。

### 原因調査・判定(3件それぞれ)

**1. longmemeval perf gate — 判定B(環境/手法アーティファクト)**
このテストは`process.env.SHARD`の有無で許容閾値を10秒(未設定時)/60秒(設定時)に切り替える設計を持つ。`scripts/run-unit-parallel.sh`は各shard起動時に`SHARD`環境変数を設定するが、v3で実施した「rc=143の直接証拠取得」のためのdirect実行はこの環境変数を設定せずに`bun test`を直接呼び出していたため、shard並列負荷という重い実行条件に単独実行用の厳しい10秒閾値を誤って適用していた。単独実行(3回×両側)は全てPASS(patched平均の方が僅かに高速)。**baseline側(Phase 9Bコード変更ゼロ)で`SHARD`未設定のまま8並列実行したところ、報告された失敗と同一のシグネチャが8/8で再現した** — Phase 9Bとは無関係であることの決定的証拠。

**2. page-search-vector-overflow #2704 — 判定B(環境/手法アーティファクト、ただし異なるメカニズム)**
30000msはCLIフラグではなく、テストファイル自身のbun `test()`第3引数によるper-testタイムアウト(`SHARD`非依存、無条件)。単独実行(3回×両側)は全てPASS(patched平均の方が僅かに高速、閾値に対し約35倍のマージン)。Phase 9Bのdiffに`pages`/`search_vector`/`content_chunks`への変更は皆無(grep 0件) — このテストの経路に触れるコード変更が存在しない。**baseline単独での並行度操作実験(1→32プロセス)のみで、対象テストの実測時間が0.77秒→24.6秒(約32倍)まで変動することを確認した**(文字通りの30秒到達は測定範囲内では再現できなかったが、原因が実行時資源競合であることを支持する直接証拠として十分と判断)。

**3. brain-repo-durability.serial.test.ts — 判定A(既存の間欠的flaky、Phase 9B非起因)**
v3報告書の「再実行で即座に解消する」という記載は1回の再実行結果のみに基づく不十分な検証だった。baseline/patched双方で3回ずつ再実行した結果、baseline 1/3回・patched 2/3回、いずれも同一のエラーシグネチャ(テスト自身が用意するローカルbareリポジトリへの`git push`失敗、ネットワーク要因ではない)で間欠的に失敗することを確認した。baseline(Phase 9Bコード変更ゼロ)でも同程度の頻度で再現することが、Phase 9B非起因であることの直接証拠。

### 機械的failセット比較(Agent C)

baseline wrapper 15件・patched wrapper 18件(v3修正後は15件相当)・patched direct 18件を機械diffした結果: baseline-onlyは0件(Phase 9Bが既存失敗に影響を与えていないことも確認)、patched-wrapper-onlyの3件は`audit-dir-preload.test.ts`(v3で解消済み)、direct-onlyの3件が上記の調査対象3件。共通15件はファイル名・テスト名・アサーション種別まで完全一致を確認。**⚠️v5内部レビュー(Documentation Reviewer)で訂正: 本節は当初「共通13件」と誤記していた。`fails.json`を直接展開して集合演算した結果、共通は15件が正しい(18−3=15)。詳細は`PHASE9B-TEST-EVIDENCE.md`§3-9-i参照。**

### 対応

**いずれもPhase 9Bの実装コードとは無関係と判定したため、ソースコードの修正は行っていない。** `phase9b-code-changes-v4.diff`は`phase9b-code-changes-v3.diff`とバイト単位で同一。対応は報告書の記述訂正のみ(`PHASE9B-TEST-EVIDENCE.md`§3-9-e〜j、本書§5・本節)。

Phase 9Bスコープ外の副次的な指摘として、page-search-vector-overflow.test.tsの30秒タイムアウトが実行時資源競合に対して本質的にマージンの薄い設計であることが判明した(隔離時実測0.8秒に対し24並行時点で閾値の82%まで到達)。同ファイルの60秒hook予算に合わせて引き上げることを恒久対応として推奨するが、本ラウンドの対応範囲外であり変更していない。

### 検証

- longmemeval: 単独実行6回全てPASS(baseline平均7.86s/patched平均7.36s、テスト単体では baseline平均2026ms/patched平均2106ms)。baseline 8並列再現実験で報告失敗シグネチャを8/8再現(平均17569ms)。
- page-search-vector-overflow: 単独実行6回全てPASS(baseline平均0.858s/patched平均0.802s)。baseline並行度スケーリング実験で0.77秒→24.6秒の変動を確認。
- brain-repo-durability: baseline/patched各3回再実行、同一エラーシグネチャで間欠的に再現(baseline 1/3、patched 2/3)。
- 機械的failセットdiff: baseline-only 0件、共通15件完全一致(v5内部レビューで「13件」の誤記を訂正)、direct-only 3件は全て個別に原因判定済み。

詳細な生ログ・実行コマンド・データ表は`PHASE9B-TEST-EVIDENCE.md`§3-9-f〜3-9-j参照。

---

## 11. 外部レビュー承認前の内部並列レビュー(v5) — REQUIRED解消(外部承認は別途・未取得)

### 背景・目的

v4提出後、外部レビュー(ChatGPT)による正式承認がまだ確認できていない段階で、ユーザーから「Phase 9Cには着手せず、代わりに内部レビューでPhase 9Bを正式完了させる」という明示的な指示を受けた。7領域の専門Reviewer(Architecture/Security/Database/Migration/Testing/Performance/Documentation)を並列起動し、REQUIRED=0になるまで修正・再レビューを繰り返す方式を採用した。

### レビュー結果サマリ

| Reviewer | REQUIRED件数 | 主な指摘 |
|---|---|---|
| Architecture | 3件 | FK`ON DELETE SET NULL`が設計文書と矛盾/認可ゲートのテストが本番コードの手写しで実ゲートをimportしていない/レガシー管理者トークン経路の未文書化ギャップ |
| Security | **0件**(Notes 7件) | 全経路を実トレースし認可バイパス・fail-open経路は確認されず。Notesの1件(N2)がArchitecture/DatabaseのFK指摘を独立に支持 |
| Database | 2件 | 同上FK問題を独立に再確認/Postgres側bootstrap経路の自動テストカバレッジがゼロ |
| Migration | 3件 | ロールバック手順書の実行順序誤りにより手順どおり実施すると自己復元してしまう/v125マイグレーションがhandler経由のため本番安全機構(リトライ・timeout上書き・診断)を全てバイパス/検証用worktreeにテストファイル2件が欠落(Testing/Documentationと合わせ3レビューが独立発見) |
| Testing | 8件 | 上記ファイル欠落/`GBRAIN_PGLITE_SNAPSHOT`によるテスト無効化潜在バグ/narrowing検証テストの判別力欠如/本番fallback5分岐中2分岐がテスト到達不能/認可マトリクスのテストヘルパーが本番から乖離/監査参照テストが監査テーブルに一切触れていない/DCR登録経路の未検証/admin scope軸の欠落 |
| Performance | 1件 | 初回7エージェント並列起動時の依頼が繰り返しの再依頼(idle_notificationのみ返り本文が届かない状態が複数回発生)にもかかわらず届かなかったが、§12の再確認ラウンドで最終的に到着(review-securityで生じた同種の配送問題が再試行で解消した前例に倣い再依頼を継続した結果)。`verifyAccessToken`の認可ホットパスに構造的に恒真(FKにより結果不変)な冗長JOINを発見。加えて6件のNotes(将来のキャッシュ化提案等、Phase 9Cへ申し送り) |
| Documentation | 11件 | 自著v4報告書の算術ミス(「共通失敗13件」→実際15件、独立に再計算し確認)/生ログと数値が食い違う複数箇所の引用/訂正されたはずの旧記述が本文に残置され矛盾/その他数値・参照の不整合多数 |

### 対応方針

REQUIRED項目は実装・テスト・報告書の3層に分かれた。実装/テストの修正はSonnet本体が直接実施し(専門サブエージェントは調査・レビュー・報告書執筆支援に利用)、各修正後はPGLite・実Postgres双方でテストを再実行して確認した。

### 実装した修正

**REQUIRED-A(Architecture#1・Database#1・Security N2、3レビュー一致): `oauth_clients.principal_id`のFKを`ON DELETE SET NULL`→`ON DELETE RESTRICT`へ変更**

設計文書(`PHASE9A-IDENTITY-MODEL-DECISION.md`・`schema.sql`のコメント)は「Principal行は物理削除しない、監査参照が残るため」と明記しているが、`SET NULL`は削除自体を許してしまい、削除された瞬間に帰属参照が静かに失われる(「一度も帰属していない」と「帰属が破壊された」が区別不能になる)。`RESTRICT`であれば削除自体が拒否され、Client行・Principal行・監査参照のいずれも生存する。同一テーブルの兄弟列`source_id`が同じ理由で過去に`RESTRICT`へ変更された前例(`migrate.ts`のコメントに記載)とも整合する。

対応: `schema.sql`・`pglite-schema.ts`・`schema-embedded.ts`(再生成)・`migrate.ts`・`pglite-engine.ts`・`postgres-engine.ts`の6箇所を`RESTRICT`へ変更。関連テスト2件(`principal-identity-foundation.test.ts`#10、`e2e/principal-postgres.test.ts`)をDELETE拒否+client/principal/監査行(`mcp_request_log`)の生存を検証する内容へ書き換え。`principal-schema-parity.test.ts`のFKアサーション文字列も修正。PGLite・実Postgres両方で再検証しPASS確認済み(現時点でPhase 9Bには書き込みAPIが存在しないため到達不能だが、Security Reviewerの指摘どおりPhase 9C/9Dで到達可能になる前に修正する方が安価)。

**REQUIRED-B(Architecture#2・Testing#5、2レビュー一致): 認可ゲートを`serve-http.ts`から`scope.ts`へ抽出、テストが実ゲートをimport**

`test/authorization-invariant-matrix.test.ts`は本番の認可ゲート(`serve-http.ts`の`requiredScope`算出+`hasScope`判定)を独自に手写しして再現していた(ファイル自体のコメントにも明記されていた既知の妥協)。本番側が将来変更されてもテスト側の手写しコードは追随せず、テストは緑のまま実際の認可ロジックの変更を検知できない状態だった。

対応: `src/core/scope.ts`に`authorizeOperation(scopes, op)`を新規export(`serve-http.ts`の該当2行を挙動不変のまま抽出する純粋な移動)。`serve-http.ts`側はこの関数を呼ぶだけに変更(ロジック自体は一切変更していない)。これまで「変更禁止領域」としてきた`serve-http.ts`への唯一の変更であり、最小限かつ検証済みの範囲に留めた。テスト側はこの関数をimportして実ゲートを検証するよう変更し、加えて`sourceId`/`takesHoldersAllowList`もハードコードではなく本番と同じ`auth`由来の導出へ修正、認可拒否時の監査ログ(`mcp_request_log`)記録も本番と同様にテスト側で再現・検証するテストを追加した。

**REQUIRED-C(Testing#2、Migration#3が別角度で同根): テスト隔離の修正**

`GBRAIN_PGLITE_SNAPSHOT`環境変数が設定されている場合、`initSchema()`の2回目呼び出しが実質no-opになり、`principal-schema-parity.test.ts`・`principal-rollback-pglite.test.ts`の「migration再実行」を前提とするアサーションが偽陽性になりうる潜在バグを両ファイルに`delete process.env.GBRAIN_PGLITE_SNAPSHOT`を追加して解消(既存の`test/bootstrap.test.ts`等と同一パターン)。**⚠️§12訂正**: この`delete`方式は`scripts/check-test-isolation.allowlist`未登録のためCI lintに違反することが§12再レビュー(Testing Reviewer N1)で判明し、`engine.connect({ database_path: <一時ディレクトリ> })`を明示指定する方式へ置換した(env操作なしで同じ効果、allowlistへの新規登録なし)。詳細は§12 REQUIRED-O参照。

**REQUIRED-D(Migration#2): v125マイグレーションの安全機構バイパスを解消**

v125は純粋なDDL/シードデータのみにも関わらず`handler`経由で実行されており、`runMigrations`の`if (sql)`ゲートに紐づく3回リトライ・`SET LOCAL statement_timeout`上書き(Supabase等のプーラー対策)・57014診断メッセージが全て素通りしていた。本番Postgresでロック競合下に本マイグレーションを流した場合、生のドライバエラーで即座に失敗し、他の全マイグレーションが受けている保護を受けられない状態だった。5文を`sql:`文字列へ移設(セミコロン区切り、v16等の既存パターンと同型)、`handler`は完了ログ出力のみに縮小、`idempotent: true`を明示。PGLite・実Postgres双方で再検証しPASS確認済み。

**REQUIRED-E(Testing#8): 認可マトリクスにadmin scope軸を追加**

`AUTHZ-INV-001`自身が例示する典型的違反(「Humanだからadmin」)を検証する軸が、既存の21テストに存在しなかった。8 Principal状態それぞれについて「readのみではadmin操作拒否」「adminがあれば全kindで許可」「adminは兄弟scope`agent`へは波及しない」の3テストを追加。

**REQUIRED-F(Testing#7): DCR登録経路(`clientsStore.registerClient`)のテストを追加**

既存テストは全て`registerClientManual`(手動/CLI相当)経由のみを検証しており、実際のDCRエントリポイントである`registerClient`は未検証だった。`principal_id`のnullデフォルト・scope忠実性、およびリクエストボディに`principal_id`を紛れ込ませても無視されることを検証するテストを追加。

**REQUIRED-G(Testing#4): `oauth-fallback-pre-phase9b.test.ts`のモノトニック設計を解消**

単一engineへの累積DROPという設計のため、本番fallbackの5分岐のうち`isUndefinedTableError(err0, 'principals')`/`(..., 'principal_kinds')`の2分岐が構造的にテスト到達不能だった。fresh-engine-per-state設計へ全面書き換え、この2つの未到達状態をそれぞれ独立したテストとして新規カバー。

**REQUIRED-H(Testing#3): narrowingテストのアサーション強化**

無関係なtable-missingエラーが吸収されないことを検証するテストが、narrowingの有無を判別できないbare `toThrow()`だった。伝播したエラーの`code`(SQLSTATE)と`message`(実際に欠けているテーブル名を含むこと)を明示的にアサートするよう強化。

**REQUIRED-I(Database#2): Postgres側bootstrap経路のテストカバレッジ追加**

Phase 9Bのforward-referenceブートストラップ(`needsPrincipalIdBootstrap`)はPGLite側のみテストされており、Postgres側は自動テストカバレッジがゼロだった(既存のPostgres-Postgres比較テストは両方とも新規DBのため、この分岐が構造的に一度も実行されない設計だった)。`test/e2e/postgres-bootstrap.test.ts`に`principal-schema-parity.test.ts`と同型のstrip/rebuildテストを追加、実Postgres上で検証しPASS確認済み。

**REQUIRED-J(Migration#1、最重要): ロールバック手順書の実行順序を訂正**

`PHASE9B-MIGRATION-AND-ROLLBACK.md`§4-2(SQLロールバック)を§4-3(コードロールバック)より先に実行する構成になっていた。Phase 9Bのコードが稼働したままSQLだけを実行すると、次にgbrainプロセスが接続した瞬間に`initSchema()`がPhase 9Bの全オブジェクトを自動的に再作成し、ロールバックが数秒以内に無言で自己復元してしまう重大な運用文書バグだった。§4冒頭に警告と正しい実行順序(全プロセス停止→コードロールバック→SQLロールバック→再起動)を追加し、§4-1に停止確認手順、§4-4に`principal_id`紐付けデータがロールバック後は再migrationしても復元不可能である旨を明記した。ソースコードの変更ではなく運用文書の訂正のみ。

**REQUIRED-K(Architecture#3): レガシー管理者トークン経路の未文書化ギャップを明示**

`AuthInfo`構築箇所3つのうち2つ(レガシー`access_tokens`経路・`http-transport.ts`経路)は構造的にPrincipal帰属を持てず、うち`access_tokens`経路は無条件でadmin scopeを返す — 最も強い権限を持つ経路が最も帰属不可能、という組み合わせが未文書化だった。本書§3-1に既知の限界として明記(ドキュメントのみの対応、コード変更なし)。

**REQUIRED-L(Documentation#2〜#11): 報告書の数値・記述訂正**

`PHASE9B-TEST-EVIDENCE.md`(共通失敗の件数13→15の算術ミス含む)・本書(同箇所)の複数箇所を実ログ・`fails.json`と再照合のうえ訂正した。詳細は`PHASE9B-TEST-EVIDENCE.md`側の該当箇所を参照。

### 検証

全修正について、PGLite側は`bun test`で該当ファイル群を、Postgres側は実Postgres(`docker-compose.test.yml`)に対して個別に再実行し、全てPASSを確認した。`bun run typecheck`もエラー0件。詳細な生ログ・実行結果数は`PHASE9B-TEST-EVIDENCE.md`§11参照。

---

## 12. §11修正への再レビュー(第2ラウンド) — 追加REQUIRED解消

### 背景

§11の修正提出後、同一の7専門Reviewerのうち応答済みの5名(Architecture/Database/Migration/Testing/Documentation)へREQUIRED解消の再確認を依頼した。**Migrationは元の3件全てクローズを確認したが、新たに1件(ロールバック文書§1・§3の`ON DELETE SET NULL`残置)を発見**、Architecture/Database/Testing/Documentationの4名は独立に**同一クラスの問題(§11の一部修正が本書・関連文書の他箇所へ反映されず、旧記述との内部矛盾が残っていた)**を発見した。加えてTestingは修正自体が持ち込んだ新規のCI lint違反(N1)を、Architecture/Testingは共通して「FKをRESTRICTへ変更した際、既にv125(SET NULL版)を適用済みの永続ブレインへの移行経路が存在しない」という懸念(REQUIRED-2/N2)を提起した。

### 再レビュー結果サマリ(第2ラウンド)

| Reviewer | REQUIRED件数(第2ラウンド) | 主な指摘 |
|---|---|---|
| Migration | 1件(元3件は全てクローズ確認) | `PHASE9B-MIGRATION-AND-ROLLBACK.md`§1・§3に`ON DELETE SET NULL`が残置(§4のみ訂正済みだった) |
| Architecture | 2件 | 本書§1-3/§2/§6が`ON DELETE SET NULL`前提・`serve-http.ts`無変更前提のまま残置し§11の記述と矛盾/v125適用済み永続ブレインへの移行経路欠落 |
| Database | コード/スキーマ観点は0件(REQUIRED-1・2とも再検証済みPASS)、文書整合1件 | 本書・`PHASE9B-TEST-EVIDENCE.md`・`PHASE9B-MIGRATION-AND-ROLLBACK.md`の計6箇所に`ON DELETE SET NULL`残置。**v125が実際に本番master(`origin/master`)へ一度もマージされていないことを`git show origin/master:src/core/migrate.ts \| grep -c "version: 125"` → `0`で実証**、v126追い修正は不要と判定 |
| Testing | 2件 | N1: §11のREQUIRED-C対応(`delete process.env.GBRAIN_PGLITE_SNAPSHOT`)が`scripts/check-test-isolation.allowlist`未登録のため`check:test-isolation`を落とす(allowlistは「縮小のみ・新規追加禁止」の方針)。N2: Architecture同様、v125適用済み永続ブレインへの移行経路懸念 |
| Documentation | 6件 | §11修正の一部(worktreeへのテストファイル追加・`serve-http.ts`変更・テスト件数増加)が関連文書の他箇所へ波及せず内部矛盾/バージョンラベル誤記(「v3」→正しくは「v5」、2箇所)/§11 Reviewer要約表にPerformance行欠落/§11-1のコマンド行と合計値の不一致 |

### 対応方針

Database ReviewerがArchitecture/Testingの「v125適用済みブレインへの移行経路」懸念を、`git show origin/master`による実証(v125は`origin/master`に一度も存在せず、この検証セッション専用の一時ブランチにのみ存在する = SET NULL版のv125を適用した永続ブレインは実在しない)で解消した。この実証結果を採用し、v126の追い修正は行わず、本節に判断根拠を明記する形で対応した(Database Reviewer自身が「この判断で問題ない」と結論している)。

残りは全てドキュメントの内部整合性の問題であり、ソースコード・テストの追加変更は不要と判断した(ただしTestingのN1(CI lint違反)のみ、実際にテストファイルの構造変更を要するためサブエージェントに委譲して対応、下記参照)。

### 実施した修正

**REQUIRED-M(Migration#新規・Database#文書整合・Documentation#3〜#5と重複): 4文書の`ON DELETE SET NULL`残置・`serve-http.ts`無変更前提の記述を`ON DELETE RESTRICT`・変更後の状態へ統一訂正**

`PHASE9B-MIGRATION-AND-ROLLBACK.md`§1・§3、本書§1-3(SQLコードブロック・「削除自体を拒否する」根拠文)・§2(対象外リスト)・§8 REQUIRED-3・REQUIRED-6、`PHASE9B-TEST-EVIDENCE.md`§3-5・§5・§6、`PHASE9B-REVIEW-MANIFEST.md`項目8の計10箇所超を、実装済みの`ON DELETE RESTRICT`・`serve-http.ts`の実際の変更内容と整合するよう訂正した。訂正は全て「旧記述→新記述」を明示する形で行い、無言の書き換えはしていない(監査可能性の維持)。**(⚠️v7注記: 本節では以後、生の行番号ではなく節番号で参照する — Documentation Reviewerの指摘どおり、編集の継続で行番号は必ずドリフトするため)**

**REQUIRED-N(Architecture#2・Testing#N2、Database調査により解消): v125適用済み永続ブレインへの移行経路懸念**

Database Reviewerが`git show origin/master:src/core/migrate.ts | grep -c "version: 125"` → `0`を実証し、v125マイグレーションが本番`master`ブランチへ一度もマージされていないことを確認した。v125は本検証作業専用の一時ブランチ(`phase9b-required-remediation-verify`)にのみ存在し、実運用ブレインが「SET NULL版のv125」を適用した状態で存在することは構造的にあり得ない。したがって、v126による制約張り替えの追い修正は不要と判断し、本節にこの判断根拠(コマンド・出力・結論)を記録することで対応とした。**将来v125がリリースされる場合は、リリース時点のFK定義(RESTRICT)がそのまま新規適用されるため、この懸念は再発しない。**

**REQUIRED-O(Testing#N1): テスト隔離CI lint違反の解消**

`test/principal-schema-parity.test.ts`・`test/principal-rollback-pglite.test.ts`の`delete process.env.GBRAIN_PGLITE_SNAPSHOT`パターンを、`engine.connect({ database_path: <一時ディレクトリ> })`を明示指定する方式へ置換(env操作なしでsnapshot分岐を無効化、`pglite-engine.ts`の`!dataDir`ガードを利用。一時ディレクトリは`mkdtempSync`で作成し`afterAll`で`rmSync`、既存の`test/enrichment.test.ts`と同じイディオム)。`principal-schema-parity.test.ts`は独立したライフサイクルを持つ2つのPGLiteインスタンス(fresh/migrated)が1つのディレクトリを共有できないため、一時ディレクトリを2つ用意した(レビュー提案の自然な拡張)。

`test/oauth-fallback-pre-phase9b.test.ts`は状態ごとの`test()`直書きから`describe()`+`beforeAll`(engine構築)/`afterAll`(disconnect)構造へ再構成し、`check-test-isolation.sh`の構造的要件(engine構築が`beforeAll`から50行以内・`afterAll`の存在)を満たすよう修正。この過程で、`check-test-isolation.sh`のR3ルールがAST解析ではなく`awk`による純粋な行ベースの文字列マッチングであることが判明し、`new PGLiteEngine(`という文字列を含むJSDocコメント(説明文中のバッククォート引用)だけで誤検知することを発見したため、該当コメントの表現を変更(コード自体は無変更)。また、8状態で共有する`initStateEngine(engine, drops)`ヘルパー自体の中に`new PGLiteEngine()`の実体を置くと、そのヘルパーの定義位置が最初の`beforeAll`より前にあるため静的スキャン上は50行制約を満たせなくなることが判明し、ヘルパーの共通化を保ちつつ、実際の`new PGLiteEngine()`構築呼び出し自体は各状態の`beforeAll`本体内に直接記述する構成へ変更した。allowlistへの新規登録は行っていない(既存方針「MUST shrink over time」を遵守)。

実行結果: `check-test-isolation.sh`は対象3ファイルにつき違反0件(残る唯一の違反`test/put-page-remote-auto.test.ts`はこのタスクが一切触れていない既存の無関係ファイル、`git status`で無変更を確認)。`principal-schema-parity.test.ts`(1 pass/13 expect)・`principal-rollback-pglite.test.ts`(4 pass/36 expect)・`oauth-fallback-pre-phase9b.test.ts`(9 pass/43 expect)いずれも修正前と同じか上回るpass数を維持(挙動変更なし)。詳細ログは`PHASE9B-TEST-EVIDENCE.md`§12参照。

**REQUIRED-P(Documentation#2): §11-1コマンド行と合計値の不一致訂正**

`PHASE9B-TEST-EVIDENCE.md`§11-1の2番目のコマンドが5ファイルの実行に見えるが、記載の合計値(56 pass/311 expect)は`principal-identity-foundation.test.ts`を含む6ファイル分だった。コマンド行に同ファイルを追記し、記載どおりの6ファイル一括実行として整合させた。

**REQUIRED-Q(Documentation#5): バージョンラベル誤記の訂正**

`PHASE9B-MIGRATION-AND-ROLLBACK.md`§4冒頭の警告ブロック・本書§4の2点目の箇条書きにあった「v3で訂正」表記を、本ラウンドの内部並列レビューを指す正しいラベルへ訂正した(本書・`PHASE9B-TEST-EVIDENCE.md`側は共通で「v5」を使用しているが、`PHASE9B-MIGRATION-AND-ROLLBACK.md`はこのファイル自身の独立したバージョンカウンタ(v1〜v4)を持つため、「本ファイルのv3改訂(他ファイルのv5と同一ラウンド)」の形で明示し、読者が別文書の「v3」と混同しないようにした)。

**REQUIRED-R(Documentation#6): §11 Reviewer要約表にPerformance行を追加**

上記「再レビュー結果サマリ」節の直前、§11の表にPerformance行を追加し、レポート本文を受領できていない旨を証跡付きで正直に記載した(推測による「0件」の記載はしていない)。**⚠️この直後、本節末尾の「追加」項でレポートが実際に到着した経緯・REQUIRED-1への対応を記録している。§11の表・本項の記述はレポート到着前の時点のスナップショットである。**

### 検証

REQUIRED-M/N/P/Qはドキュメントのみの訂正であり、ソースコード・テストへの影響はない。REQUIRED-Oの検証結果(`check-test-isolation.sh`の実行結果・影響を受けた3ファイルの再実行pass/fail/expect数)は`PHASE9B-TEST-EVIDENCE.md`§12に記載する。全修正後、Migration/Architecture/Database/Testing/Documentationへ再確認を依頼した(結果は本書末尾または`PHASE9B-REVIEW-MANIFEST.md`側に集約)。

### 追加: Performance Reviewerの初回報告とREQUIRED-1(冗長JOIN)対応

上記の再レビュー依頼と並行して、初回から複数回応答が届かなかったPerformance Reviewerのレポートが到着した(§11の表を更新済み)。コード解析専用(テスト実行・編集なし)のレビューで、REQUIRED 1件・Notes 6件を報告した。

**REQUIRED-1(Architecture Note・Database N1と3レビュー一致): `verifyAccessToken`の認可ホットパス上の冗長JOINを削除**

`src/core/oauth-provider.ts`のクエリが`LEFT JOIN principal_kinds pk ON pk.id = p.kind_id`から`pk.id AS principal_kind`を取得していたが、`principals.kind_id`が`TEXT NOT NULL REFERENCES principal_kinds(id)`である以上、`pk.id`は構造上つねに`p.kind_id`と一致し、このJOINは結果を変えない恒真な冗長JOINだった。`verifyAccessToken`は認証済みMCPツール呼び出し毎に実行されキャッシュが無いため、Supabase/PgBouncer(prepared statement無効)構成ではリクエスト毎の再パース・再プランニングコストが無償で発生し続けていた。

対応: SELECT列を`p.kind_id AS principal_kind`へ変更し`LEFT JOIN principal_kinds`行を削除。この結果、`principal_kinds`テーブル欠落によるこのクエリの失敗経路自体が構造的に消滅するため、`catch`ブロックの`isUndefinedTableError(err0, 'principal_kinds')`も削除(`isUndefinedTableError(err0, 'principals')`は残置)。

**副作用として1テストの期待値が意図的に変更された**: `test/oauth-fallback-pre-phase9b.test.ts`の「`principal_kinds`テーブル欠落・`principals`+`principal_id`は現存」状態のテストは、修正前は「クエリがJOINで失敗し`principalId`/`principalKind`とも`undefined`へ縮退する」ことを検証していたが、修正後はこのクエリが`principal_kinds`テーブルの存在に依存しなくなったため、同じ状態で**成功**し`principalKind`が`principals.kind_id`の値(テストのセットアップ値`'human'`)から正しく解決される。これは劣化ではなく改善(より少ない状態依存)であり、テスト名・アサーションをこの新しい正しい挙動に合わせて更新した。他の2状態(`principal_id`列欠落、完全pre-v125)は`principal_id`列自体の欠落チェックが先に発火するため無影響であることを確認済み。

再検証結果: `bun run typecheck`エラー0件。`oauth-fallback-pre-phase9b.test.ts`(9 pass/0 fail/43 expect、テスト数不変)・`principal-identity-foundation.test.ts`(13 pass/0 fail/29 expect)・`authorization-invariant-matrix.test.ts`(49 pass/0 fail/185 expect)・oauth回帰4ファイル(116 pass/0 fail/460 expect)・実Postgres`e2e/principal-postgres.test.ts`(13 pass/0 fail/46 expect)、全てPASS。worktreeミラーへも反映・staging済み。

**Testing Reviewerによる追加確認**: `oauth-fallback-pre-phase9b.test.ts`の変更(REQUIRED-4のカバレッジに直接触れるため)についてFYI連絡したところ、Testing Reviewerが実ファイルを読んで独立検証し、「JOIN削除の等価性は証明可能」「死んだ分岐(`isUndefinedTableError(err0, 'principal_kinds')`)が正しく除去されている」「テスト更新はundefined期待からの緩和ではなくむしろ強いアサーション」と確認、テスト領域のREQUIRED=0を維持する旨の回答を得た。あわせて非ブロッキングの軽微な指摘(ファイル冒頭JSDocの旧記述が「分岐は今も2本」と誤読されうる)を受け、該当コメントに一言明確化を追加した(挙動不変、コメントのみの差分)。

**Notes(N-1〜N-6)への対応**: N-1・N-2(bootstrap実行頻度・インデックス書込み増幅)はコード解析の結果「問題なし」の確認のみで対応不要。N-3(フェーズ別コスト表の測定精度批判)は`PHASE9B-TEST-EVIDENCE.md`該当箇所を「参考値」へ改称し補足説明を追加。N-4(pre-v125 brainの二重往復)・N-5(verifyAccessTokenのキャッシュ欠如)・N-6(RLS非対称性、DB/セキュリティ領域への申し送り)はいずれも将来Phase向けの構造提案のためBeadsへ登録した(`dashboard-feibe`・`dashboard-ikosb`・`dashboard-m1ja3`)。

あわせて、Architecture Reviewerの最終確認で依頼された未登録Notes 4件(うち1件は上記REQUIRED-1と同一のためこのラウンドで対応済み、残り3件)も対応した: `schema.sql`の`principal_id`列にRESTRICTの理由コメントを追加(`src/schema.sql`・`schema-embedded.ts`再生成)、`probe as unknown as`キャスト(`pglite-engine.ts`/`postgres-engine.ts`)と`Scope`型3重定義はBeadsへ登録(`dashboard-84p97`・`dashboard-5qp17`)。

**REQUIRED-S(Documentation、§12対応の副作用): `GBRAIN_PGLITE_SNAPSHOT`旧方式の記述残置4箇所**

REQUIRED-Oで実装方式を`delete process.env.GBRAIN_PGLITE_SNAPSHOT`から`engine.connect({ database_path: ... })`へ変更した際、この変更を反映すべき4箇所(`PHASE9B-TEST-EVIDENCE.md`§11-3、本書§5表2箇所、§11 REQUIRED-C)が旧方式のまま取り残されていた。Documentation Reviewerの指摘を受け、いずれも「§12訂正」注記付きで新方式に言及するよう修正した。

**REQUIRED-T(Documentation): Performance到着時点でのREQUIRED-1対応記録の欠落**

Documentation Reviewerが§11の表を確認した時点(Sonnetが「未受領」→「1件」へ更新した直後)では、REQUIRED-1(冗長JOIN)への対応記録がまだ本書に存在しなかった(執筆中の状態を見られた)。直後に本節末尾の「追加: Performance Reviewerの初回報告とREQUIRED-1対応」を追記し解消した。

**REQUIRED-U(Documentation): Performance関連の件数・受領状態の記述矛盾**

本書冒頭の改訂サマリ2箇所の「24件超」「Performanceは0」、`PHASE9B-REVIEW-MANIFEST.md`の「受領できておらず」等、Performance到着前の状態を記述したまま取り残されていた複数箇所を、到着後の実態(28件・Performance 1件・対応済み)へ訂正した。**⚠️v7で判明**: この訂正は本書冒頭の改訂サマリ2箇所にしか適用されておらず、同種の「24件超」表記が本書§12冒頭部・`PHASE9B-TEST-EVIDENCE.md`§0・`PHASE9B-REVIEW-MANIFEST.md`§14の計3箇所に残置されたまま次のラウンドへ持ち越されていた(外部監査後のconsistency-audit-v7が独立発見、§13-2参照)。v7で全箇所を訂正済み。

---

## 13. 完全なREQUIRED台帳(全43件、v7で新設)

外部監査(ChatGPT)がv6を「未承認・REQUIRED 3件」と判定し、その対応の一環でユーザー指示によりconsistency-audit-v7(独立監査エージェント)を起動した結果、本書・`PHASE9B-TEST-EVIDENCE.md`・`README.md`等に散在する「◯件超」という曖昧な集計表現が、同一文中の内訳合計とすら一致しない箇所を含め複数発見された(v6 README.mdの「9件超(Documentation 6+3・Migration 1・Architecture 2・Testing 2)」は内訳合計14で「9」と不整合、等)。本節はこの問題を再発させないため、**全REQUIRED項目を1件ずつ数え上げた台帳**として新設し、以後の全文書はこの台帳を参照するのみとし、本文中で集計値を独自に再計算・再記載しない方針とする。

### 第1ラウンド(§11): 28件

| Reviewer | 件数 | 内訳(§11対応ID) |
|---|---|---|
| Architecture | 3 | REQUIRED-A(FK)・REQUIRED-B(認可ゲート抽出)・REQUIRED-K(レガシートークン文書化) |
| Security | 0 | — |
| Database | 2 | REQUIRED-A(同上、Architecture/Security N2と3レビュー一致)・REQUIRED-I(Postgres bootstrap カバレッジ) |
| Migration | 3 | REQUIRED-J(ロールバック順序)・REQUIRED-D(v125 handler→sql:)・REQUIRED-G/ファイル欠落(worktreeへのテストファイル2件追加、Testing#1と同一事象) |
| Testing | 8 | REQUIRED-G(ファイル欠落、Migration#3と同一事象)・REQUIRED-C(GBRAIN_PGLITE_SNAPSHOT原型)・REQUIRED-H(narrowing強化)・REQUIRED-G(fresh-engine-per-state、2分岐カバー)・REQUIRED-B(認可マトリクス手写し、Architecture#2と同一)・監査参照テスト強化(REQUIRED-A対応に統合)・REQUIRED-F(DCR経路)・REQUIRED-E(admin scope軸) |
| Documentation | 11 | REQUIRED-L(算術ミス・生ログ不一致・残置記述等、詳細は§9・§10・当時の個別訂正箇所) |
| Performance | 1 | 「REQUIRED-1(冗長JOIN)」(本書§12末尾「追加」参照。配送遅延により到着は§12ラウンド中だが、7エージェント同時ディスパッチという発生時点の性質上、第1ラウンドの一員として計上) |

**小計: 3+0+2+3+8+11+1 = 28**

### 第2ラウンド(§12、§11修正への再レビュー): 15件

| Reviewer | 件数 | 内訳(§12対応ID) |
|---|---|---|
| Migration | 1 | REQUIRED-M(ロールバック文書のSET NULL残置) |
| Architecture | 2 | REQUIRED-M(報告書残置記述、Migration/Databaseと重複部分あり)・REQUIRED-N(v125移行経路懸念) |
| Testing | 2 | REQUIRED-O(CI lint違反)・REQUIRED-N(同上、Architectureと同一懸念をTestingが独立提起) |
| Database | 1 | REQUIRED-M(文書6箇所のSET NULL残置、コード/スキーマ観点は0件) |
| Documentation | 9 | 第1回確認(6件): REQUIRED-M(worktree/フルスイート範囲注記)・REQUIRED-P(§11-1コマンド不一致)・REQUIRED-M(serve-http.ts残置5箇所)・REQUIRED-M(件数新旧不一致4箇所)・REQUIRED-Q(バージョンラベル誤記2箇所)・REQUIRED-R(Performance行欠落)。第2回確認(3件、Performance到着後に追加発見): REQUIRED-S(GBRAIN_PGLITE_SNAPSHOT残置4箇所)・REQUIRED-T(Performance対応記録の欠落)・REQUIRED-U(件数矛盾、後述のとおりv7まで一部残置) |

**小計: 1+2+2+1+9 = 15**

### 総計: 28 + 15 = **43件**、43件対応

本書・`PHASE9B-TEST-EVIDENCE.md`・`PHASE9B-REVIEW-MANIFEST.md`・`README.md`・`COMPLETION-REPORT.md`のいずれかに「◯件超」という曖昧表現が残っている場合、それは本節より古い記述であり本節の数値(28+15=43)を正とする。

---

## 14. v6外部監査「未承認・REQUIRED 3件」への対応(v7)

v6のReview Bundleを外部レビュー(ChatGPT)へ提出したところ「未承認・REQUIRED 3件」の判定を受けた。ユーザー指示によりSonnet本体は統合・最終品質保証に専念し、4エージェント(review-documentation-v7・review-performance-v7・regression-v7・consistency-audit-v7)を並列委譲した。各エージェントには担当範囲・権限・完了条件を明示し、未確認範囲が生じた場合は完了扱いにせず明示的にエスカレーションすることを義務付けた。

**REQUIRED-1(Beads状態と報告書の不一致)**: 根本原因は、Beads `dashboard-vyyod`を`CLOSED`更新した後にReview Bundleを構築した際、`beads-task-info.txt`のスナップショット取得を更新前のタイミングで行っていたこと(`COMPLETION-REPORT.md`は更新後の状態を記載していたため、バンドル内部で自己矛盾していた)。Beadsを`IN_PROGRESS`/`REVIEW_PENDING`へ即座に差し戻し、consistency-audit-v7が独立監査で発見した付随7件(git-diff-tracked-files.txtの3ファイル欠落・changed-files/への31個の不正ディレクトリ混入・「24件超」表記残置3箇所・第2ラウンドREQUIRED件数の算術不整合・reports/changed-files内訳の不一致2件)も全て解消した。詳細は`PHASE9B-TEST-EVIDENCE.md`§14参照。

**REQUIRED-2(Documentation/Performance独立最終確認)**: review-documentation-v7が3往復で計14件、review-performance-v7が実Postgresでの`EXPLAIN`実測込みの再検証を実施し、いずれも最終的に**PASS(REQUIRED=0)**。詳細は`PHASE9B-TEST-EVIDENCE.md`§14参照。

**REQUIRED-3(フル回帰+baseline機械比較)**: regression-v7が一時worktree(検証専用コミット`e7236677`)でPhase 9Bの全変更を適用し、patched/baseline双方のフルスイート(Unit全shard・serial・release・Phase 9B専用・OAuth回帰・Postgres e2e、各55分)を同一環境で機械比較した。ユーザー指定6合格基準を全て達成し**PASS(REQUIRED=0)**。副次的に、過去ラウンドで謎とされていたrc=143の正体を特定した(`run-unit-parallel.sh`の`SHARD_TIMEOUT=1500`が実測shard時間より短く、正常進行中のshardをSIGTERM終了させていたことが原因。Beads`dashboard-ateb8`へ登録)。詳細な実測証跡は`PHASE9B-TEST-EVIDENCE.md`§14参照。

**総括**: 外部監査の3件全てに独立エージェントによる検証込みで対応した。**ただしこれは内部レビュー(Sonnet統合+4独立エージェント)による検証であり、外部レビュー(ChatGPT)自身による再承認ではない。** v7 Bundleを再提出し、外部レビューによる正式承認を得るまで、Phase 9Bは正式完了として扱わない。Beads `dashboard-vyyod`もIN_PROGRESS/REVIEW_PENDINGを維持する。
