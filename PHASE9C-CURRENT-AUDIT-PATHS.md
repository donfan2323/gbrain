# Phase 9C — 現状監査: 監査ストレージ・Identity/Auth経路・プロトコル別エントリポイント・Schema/Migration・テスト資産・先行設計文書(Stage1統合、実装なし)

**日付**: 2026-08-02
**対象**: `/Users/lab/AI_Workspace/gbrain`(working tree。読み取りのみ、変更なし)
**方法**: Stage1(6エージェント並列、実ファイル読み取り・grep調査、一部 `bun test`/`bd show` 実行を含む)の結果を統合・体系化したもの。Stage2(Opusによる正式設計)は各節末尾の「Phase 9C設計文書との対応」でのみ、示唆の裏付けとして軽く参照する。根拠のない推測は記載していない。推測にとどまる事項は明示的に「(推測)」と記す。未確認の範囲も正直に列挙する。

---

## 0. 本書の位置づけ

本書は Phase 9C(Audit Event統合)着手前の**現状監査**である。**実装を一切含まない**。目的は、Stage1で6エージェントが並列に確認した「gbrainの監査ストレージ・認証経路・プロトコル別エントリポイント・スキーマ機構・既存テスト資産・先行設計文書とBeads技術的負債」に関する事実を、証跡(ファイルパス+行番号)とともに整理・体系化することのみである。新しい設計判断はここでは行わない。設計そのものは `PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md` 以下の後続設計文書群(Stage2 Opus設計)を正本とする。

---

## 1. ユーザー確定事項(2026-08-02)

Stage2(Opus設計)の `open_questions_for_user`(ユーザーへの意思決定要請4件)に対し、ユーザーは2026-08-02付で以下4件を確定した。以降の設計文書・実装はこの4件を前提として進める。

**(a) Phase 9B実装34ファイルの扱い**
Phase 9B(Universal Identity Foundation)の実装34ファイルは、独立コミット済み(`commit fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。本書 §7 が記録する「working treeに34件の未コミット変更が存在する」という事実は **Stage1調査時点(コミット前)のスナップショット**であり、現時点では解消済みである。Phase 9Cはこのコミットの上に積み上げる形で進行する。

**(b) oauth_clients の hard delete → soft delete 統一は今回は実施しない**
`src/commands/auth.ts:315` に実在する `DELETE FROM oauth_clients` の hard delete 経路(Opus設計 `migration_and_schema_plan` の FK 例外1 で言及)を soft delete(`deleted_at` 列)へ統一する作業は、Phase 9Cのスコープに含めない。したがって `audit_events.client_id` は Opus提案どおり FK なしの非正規化列のまま設計する。soft delete 統一自体は独立の bd タスクとして扱う(Phase 9C の non-goal)。

**(c) /admin/api/* の読み取り専用GET 11ルートは監査対象外のまま**
本書 §4 が確認した `/admin/api/*` の読み取り専用GET 11ルート(`jobs/watch`・`health-indicators` 等の高頻度ポーリング系を含む)は、Opus提案どおり Phase 9C の監査対象に含めない。Authority 状態を変更しない読み取り専用操作は audit_events の対象外(non-goal)として明確に扱う。管理画面での「Authority状態を変更する」9ルート(issue-magic-link・api-keys発行/失効・register-client・update-client-ttl・revoke-client・sign-out-everywhere・POST `/admin/login`・GET `/admin/auth/:token`)は引き続き監査対象(IN)である。

**(d) gbrain audit prune の既定は自動削除なし**
本書 §2 が確認した「`mcp_request_log` に保持期間・削除処理が一切存在しない」という現状に対し、Phase 9Cで新設する `gbrain audit prune --older-than <days> [--dry-run]` は Opus提案どおり **既定で自動削除を行わない**。監査記録の無言削除は増加放置より有害という判断であり、`op_checkpoints` の実働7日パージ(§2参照)とは意図的に異なる運用方針を採る。

---

## 2. 監査ストレージ(mcp_request_log / agent-audit.ts / その他JSONL群)

### 確認済み事実

- `mcp_request_log` は `CREATE TABLE IF NOT EXISTS` として **4箇所に独立して重複定義**されている: `src/schema.sql:627-637`、`src/core/pglite-schema.ts:861`、`src/core/schema-embedded.ts:631`、`src/core/migrate.ts:168`(マイグレーション経路)。加えて `postgres-engine.ts:808-815` / `pglite-engine.ts:787-794` に旧バージョンブレイン向けの `ALTER TABLE ADD COLUMN IF NOT EXISTS` 自己修復ロジックがある。
- 列構成: `id SERIAL PK, token_name TEXT, agent_name TEXT, operation TEXT NOT NULL, latency_ms INTEGER, status TEXT NOT NULL DEFAULT 'success', params JSONB, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()`。`principal_id`・`job_id` 列は存在しない。
- インデックスは `idx_mcp_log_time_agent(created_at, token_name)` と `idx_mcp_log_agent_time(agent_name, created_at DESC)` の2つのみ(`src/schema.sql:762-763`)。`operation`・`status`・`params`(JSONB)に対する索引(GIN含む)は存在しない。
- リポジトリ全体で `INSERT INTO mcp_request_log` を行っているのは `src/commands/serve-http.ts` の7箇所と、`src/mcp/http-transport.ts` 内の `logRequest()` 関数(238-242行付近、9箇所の呼び出し元から使用される独自のINSERT文、こちらもtry/catchのbest-effort)の**計2ファイル**である。ただし `http-transport.ts` は本レポート§3・§4・§8で確認済みのとおり本番到達不能なdead code(`package.json` のbinエントリから起動されず、`test/http-transport.test.ts`・`test/e2e/http-transport.test.ts` からのみ実行される)であり、実運用上のリスクは限定的である。`serve-http.ts` 側の7箇所のうち6箇所(1941/1981/2020/2116/2148/2170行)は POST `/mcp`・`/mcp-v2` のHTTPハンドラ内。残る1箇所(2407行、`operation='webhook_ingest'` のINSERT文)は POST `/ingest` ハンドラ内(2263-2453行、§4参照)である。
- 7箇所すべてが `try { await executeRawJsonb(...) } catch { /* best effort */ }` で囲まれている。書き込み失敗は「best effort」として完全に握りつぶされ、リトライ・二次記録・失敗自体のログ・fail-closed処理は一切ない。
- `params` 列の既定記録内容は `src/mcp/dispatch.ts:128-168` の `summarizeMcpParams()` が生成する。宣言済みparamsキー名の許可リストと一致したキー名のみ(値は含まない)+ `unknown_key_count` + `approx_bytes`(バケット化)を返す。生の値・攻撃者制御のキー名そのものは既定では記録されない。
- `--log-full-params` フラグ(`src/commands/serve.ts:107`、`serve-http.ts:300-309`)を付けた場合のみ raw paramsオブジェクトがそのまま `mcp_request_log.params` とSSE配信に流れる。既定は無効。有効時はサーバ起動時に stderr へ警告を出す(`serve-http.ts:448-452`)。
- `src/core/minions/agent-audit.ts` の `logAgentSubmission()`(72-88行)は `mcp_request_log` とは別系統のJSONLファイル(`~/.gbrain/audit/agent-jobs-YYYY-Www.jsonl`、`GBRAIN_AUDIT_DIR`で上書き可)への書き込みで、`fs.appendFileSync` を try/catch で囲み、失敗時は stderr 出力のみでthrowしない。プロンプト本文は記録対象外(`prompt_byte_count`のみ記録、35-49行のinterfaceコメントで明言)。
- `src/core/audit/audit-writer.ts` の `createAuditWriter()`(174-254行)は5個以上の手書きJSONL監査モジュールを置き換えた共通プリミティブで、ヘッダコメント(29-46行)に「disk-full攻撃者は監査証跡を無言で無効化できる」「operational trace であって forensic insurance ではない」と明記。同コメントは **T-todo-3** として「v0.41+でfail-open eventをDBテーブルに送る」将来課題を名指ししている。
- `TODOS.md:2467` に T-todo-3 が未完了として記載: 「fail-open audit events を DB テーブルへ移す(cross-deploy observability)、6監査モジュール(rerank/shell/supervisor/slug-fallback/phantom/graph-signals)に影響、v0.41 audit-infra wave予定」。`CHANGELOG.md:8379` にも同旨の記述がある。
- `src/core/minions`・`src/core/audit`・`src/core/skillpack`・`src/core/schema-pack` 配下等に grep で **15個以上(調査時点で少なくとも18個を具体的に確認)** の独立した `*-audit.ts` JSONLモジュールを確認: agent-audit, shell-audit, supervisor-audit, subagent-audit, skillpack/audit, schema-pack/mutate-audit, schema-pack/candidate-audit, audit/pool-recovery-audit, audit/content-sanity-audit, audit/self-upgrade-audit, audit/lock-renewal-audit, audit/db-disconnect-audit, audit/batch-retry-audit, skillopt/audit, facts/phantom-audit, facts/stub-guard-audit, progressive-batch/audit, minions/backpressure-audit。いずれも `mcp_request_log` テーブルとは別系統。ただしこれは網羅的な全数調査ではなく、リポジトリの構造上、実際の該当モジュール数は28〜30個前後に及ぶ可能性がある(rerank-audit.ts・audit-slug-fallback.ts・minions/lease-pressure-audit.ts・search/graph-signals.ts等、追加で存在することを確認済み)。正確な総数はPhase 9Cの設計判断(このカテゴリ全体を対象外とする判断)には影響しない。
- `src/core/ingress-diagnostic.ts` は上記いずれとも別の一時的診断ロガーで、書き込み先は `GBRAIN_AUDIT_DIR` を尊重しないハードコード絶対パス `/Users/lab/Library/Logs/gbrain-http-ingress-diagnostic.jsonl`。mode `0o600`。明示的redactionルール(10-17行、`Authorization header, Cookie, token, code_verifier, client secret, request/response body, full query string, state, full client_id, PII は絶対に平文で出さない`)があり、`extractSafeQueryFields()`(48-69行)はallow-listのみ通す設計。`serve-http.ts:627-638` で実際にログされるヘッダも host/user-agent/accept/content-type/content-length/origin/referer/CORS preflight2種と `X-Forwarded-For`・`Forwarded` の有無を示すbooleanのみ。ファイル冒頭コメントに「TEMPORARY DIAGNOSTIC MODULE (Unit E-6, 2026-07-25)」と明記。
- `mcp_request_log` に対する DELETE/TRUNCATE/保持期間処理はリポジトリ内(`src/`)のどこにも見つからなかった(grep網羅)。
- 対照として `op_checkpoints` には実働の保持処理がある: `src/core/op-checkpoint.ts:489-509` の `purgeStaleCheckpoints(engine, 7)` が7日TTLでDELETEを実行し、`src/commands/jobs.ts:2009-2010` の `purge` ジョブハンドラから実際に呼び出されている。
- migration v93(`migrate.ts:4264-4325`)で追加された `minion_lease_pressure_log` / `minion_budget_log` / `minion_self_fix_log` の3監査テーブルについて、マイグレーションのコメント(4286-4289行)は「保持スイープ(Eng D8)は同waveで出荷済み」と主張しているが、`src/` 配下を grep した限り、この3テーブルへの `DELETE FROM` 文は `test/*.test.ts` のテストクリーンアップにしか見つからず、本番コード内には見つからなかった。
- `mcp_spend_log`(migration v77、`migrate.ts:3185-3235`)にも保持処理は見つからなかった。
- `src/schema.sql:1449-1505` の RLS有効化ブロックに `mcp_request_log` は含まれている(1478行)。同ブロックのテーブル列挙リストに `principals`・`principal_kinds`・`mcp_spend_log`・`mcp_spend_reservations` のいずれも含まれていない。
- `src/core/operations.ts`(5588行、全operations定義)を password/secret/apiKey/api_key/credential/token でgrepした結果、資格情報を意味する名前のparamsフィールドは見つからなかった。ただし `sources_add` オペレーション(3895-3969行)の `url` パラメータは「HTTPS git URL」と説明されており、資格情報埋め込みURL(例: `https://user:TOKEN@host/repo.git`)を構文上受け付けられる。既定redactionではキー名 `url` のみが記録され値は記録されないが、`--log-full-params` 有効時はurlの値がそのまま `mcp_request_log.params` とSSEに書き込まれる経路であり、値に対する専用スクラブ処理は見当たらなかった。
- `error_message` 列は `src/core/errors.ts:79-93` の `serializeError()` が生成する。`StructuredAgentError` 以外の一般Errorの場合は `value.message` をそのまま通す実装で、専用のredaction/スクラブ処理は見当たらなかった。
- `PHASE9C-PREREQUISITES.md`(リポジトリルート、2026-08-02付)が既に存在し、Phase 9Cのスコープを「`principals`テーブルは既存のため`mcp_request_log`への`principal_id` FK追加は素直に乗る」「`job_id`はPhase 9Bで意図的に対象外」と記述。AuthInfo構築経路が3つ存在し、(a)以外はprincipal帰属が構造的に不可能である点、(b)は無条件に `scopes:['read','write','admin']` を返す最強権限経路である点を明記している(詳細は §3)。

### 推測にとどまる事項

- (推測) 「Eng D8」保持スイープが `src/` 以外(運用スクリプト・cron・別ブランチ・別バージョン)に実在するかは未確認。今回はこのチェックアウトの `src/` 配下grep結果のみに基づく。
- (推測) stdio(非HTTP)MCPトランスポート経由の呼び出しが `mcp_request_log` に絶対に書き込まないことは、grepでINSERT箇所が0件だった事実からの強い状況証拠だが、dispatch.ts経由の全呼び出し経路を実行トレースして確認したわけではない(§4で別エージェントが `src/mcp/server.ts` を全文読了し裏取り済み)。

### 未確認事項

- 他の `*-audit.ts` JSONLモジュール(前述の通り、網羅調査ではないため実数は28〜30個前後に及ぶ可能性がある)それぞれの記録フィールドに個別の秘密情報混入がないかは、`agent-audit.ts` / `audit-writer.ts` / `ingress-diagnostic.ts` の3つを詳細に読んだのみで、残りは個別のフィールド精査までは行っていない。
- 実行時の実データ(実際のDBレコード・実際のログファイル内容)は確認していない。全て静的ソースコード読解に基づく。
- `mcp_spend_reservations` テーブルのCREATE TABLE定義箇所(`migrate.ts:3845`付近)は存在確認のみでフルには読んでいない。

### Phase 9C設計文書との対応

上記の「7箇所全てbest-effort/silent-swallow」「保持期間ゼロ」「監査系統が15+モジュールに分散」という事実群が、Opus設計 `mcp_request_log_disposition`(新表 `audit_events` + 互換ビューへの移行、`mcp_request_log`は凍結)、`failure_policy`(3クラスのfail-open/fail-closed分離)、`jsonl_disposition`(クラスA/Bの2分類とT-todo-3への棲み分け)、`migration_and_schema_plan`(`gbrain audit prune` 既定無効)の直接の根拠になっている。

---

## 3. Identity/Auth経路(3つのAuthInfo構築サイト)

### 確認済み事実

- AuthInfoの実オブジェクト構築サイト(object literal)は `src/core/oauth-provider.ts`(2箇所)と `src/mcp/http-transport.ts`(1箇所)の**計3箇所のみ**。全リポジトリgrepでこれ以外の構築サイトは存在しない。
- **(a) OAuthパス** — `oauth-provider.ts` の `verifyAccessToken()`、`oauth_tokens JOIN oauth_clients LEFT JOIN principals` のクエリ成功時(660-667行、737-776行)。`principal_id`/`principals.kind_id` を直接SELECTし、`AuthInfo.principalId`(774行)・`AuthInfo.principalKind`(775行)に代入する。値がSQL NULLの場合は `?? undefined` でundefinedに正規化される(「undefined = 帰属なしという正当な状態」)。
- **(a') pre-v125フォールバック** — 同ファイル692-735行。`principal_id`/`principals`/`principal_kinds` 列・テーブル欠落を `isUndefinedColumnError`/`isUndefinedTableError` で検知し、principal関連列を一切SELECTしないクエリへ多段フォールバックする。この場合 `principalId`/`principalKind` キー自体がオブジェクトに存在しない。
- **(b) レガシー access_tokens パス** — 同じ `verifyAccessToken()` 内、`oauthRows.length===0` 時のフォールバック(783-833行)。SELECT対象は `name, permissions` のみ。`access_tokens` テーブルには `principal_id` 列自体が存在しない(`src/schema.sql:612-620`)。scopesは825行で `scopes: ['read', 'write', 'admin']` と**無条件のハードコード**。`principalId`/`principalKind` キーは返却オブジェクトに一切含まれない。
- `access_tokens.scopes TEXT[]` 列(`schema.sql:616`)は `gbrain auth create`(`src/commands/auth.ts:89`)が書き込まず、`verifyAccessToken()` 側のSELECT(786-798行)も参照しない。**DBスキーマ上は存在するが完全に未使用(vestigial)**であり、実際のスコープ判定は常に825行のハードコード値のみで決まる。
- **(c) `src/mcp/http-transport.ts` の独自レガシー経路** — `oauth-provider.ts` とは完全に別実装。`validateToken()`(188-236行)が `access_tokens` を直接SELECT(193-196行: `id, name, permissions`)し、AuthInfoを構築する(215-222行)。scopesは `[]`(空配列)であり(b)の `['read','write','admin']` とは異なる。`principalId`/`principalKind` キーは一切存在しない。
- `http-transport.ts` の `tools/call` ハンドラ(374-396行)は `dispatchToolCall()` を直接呼び出すのみで、`hasScope()`/`authorizeOperation()` のいずれも呼び出していない(grepで `src/mcp/dispatch.ts` 内にも呼び出しなしを確認)。**この経路ではscopesフィールドは事実上デコレーションであり、有効なレガシートークン保持者はスコープに関わらず任意の操作を呼び出せる**。
- `src/commands/serve.ts`(72-145行、全文読了)を確認した結果、`gbrain serve --http` は例外なく `src/commands/serve-http.ts` の `runServeHttp` へディスパッチする(130-132行)。コメント(77-82行)は「Master's simpler startHttpTransport from v0.22.7 is superseded」と明記。
- リポジトリ全体grepの結果、`startHttpTransport`関数を実際にimport/呼び出ししているのは `test/http-transport.test.ts` と `test/e2e/http-transport.test.ts` の2テストファイルのみ。`package.json` の bin エントリは `{"gbrain": "src/cli.ts"}` の1つのみで、`http-transport.ts` を起動する代替エントリポイントは存在しない。**「`http-transport.ts` は本番到達不能(dead code)」という結論**は、`PHASE9A-EVIDENCE-MANIFEST.md:45`・`PHASE9A-SUPPLEMENTAL-AUDIT.md:247` が既に部分的に把握していたものを、本調査が package.json bin エントリの精査とテスト経由起動可能性の確認で補強・確定させたもの。
- `requireAdmin`(`serve-http.ts:1364-1377`)は `req.cookies.gbrain_admin` セッションIDが `adminSessions`(572行: インメモリ `Map<string, number>`)に存在し期限内かのみを確認する。`hasScope()`/`authorizeOperation()` の呼び出しは一切行われない。
- `adminSessions` のセッションはブートストラップトークン(またはマジックリンクnonce)から生成され(1231-1250行, 1301-1360行)、`sessionId→expiresAt` のみを保持する。`client_id`・`oauth_clients.client_id`・`principals.id` のいずれとも一切紐付いていない — **adminセッションには「どのクライアント/どのPrincipalか」という概念自体が存在しない**。
- `requireAdmin` 配下の `/admin/api/*` エンドポイント(合計18ルート: Authority状態を変更するmutatingルート7件+読み取り専用GETルート11件、1387-1827行付近)は `AuthInfo`/`CoreAuthInfo` オブジェクトを一切構築・参照しない。`AuthInfo` 型が使われるのは `/mcp`,`/mcp-v2`(1918行)と `/ingest`(2270行)の2箇所のみ。
- GitHub Webhook(POST `/webhooks/github`、2479-2605行)は AuthInfo を一切構築しない。認証は per-source の HMAC-SHA256(`sources.config.webhook_secret`、2559-2580行)を `X-Hub-Signature-256` ヘッダと `safeHexEqual`(タイミング攻撃耐性比較)で照合する方式。コメント(2458行)で「Anonymous endpoint by necessity(GitHub doesn't carry an OAuth token)」と明記。成功時に発行されるジョブは `source.id` にのみ紐付き、client_id/principal_idいずれも関与しない。
- stdio MCP経路(`src/mcp/server.ts`)は `CallToolRequestSchema` ハンドラ内で `dispatchToolCall(..., { remote: true, ... })` を呼ぶが、`auth` フィールドを一切渡していない(38-46行コメント: 「stdio MCP has no per-token auth (local pipe)」)。remote:trueでありながら `ctx.auth` は常にundefined。
- `operations.ts` の whoami ハンドラ(3863-3867行)は `if (!ctx.auth) throw new Error('whoami called over a remote transport that did not thread ctx.auth. This is a transport bug ...')` という明示的ガードを持つ。stdio経路(remote:true, auth:undefined)でwhoamiを呼ぶと構造的にエラーになる、開発者コメント上は「トランスポートのバグ」とされているが現行実装では回避不能な既知の到達パターン(本調査で新規発見)。
- ローカルCLI経路(`gbrain call`、`src/mcp/server.ts` の `handleToolCall`、および `src/commands/capture.ts:559-574` 等)はいずれも `remote:false` であり、`auth` フィールドを一切設定しない(undefined)。
- `src/core/operations.ts` の `AuthInfo` インターフェース定義(264-337行)で `principalId`/`principalKind` のドキュメントコメントは「NOT used in any authorization decision (AUTHZ-INV-001): attribution/audit metadata only」「Undefined … a fully valid, permanent state — NOT a degraded or denied one」と明記。
- `src/core/scope.ts` の `hasScope()`/`authorizeOperation()` はいずれも `grantedScopes`(文字列配列)のみを引数に取り、`principalId`/`principalKind`/`clientId` を一切参照しない。ファイル全体(141行)を読んだ限りPrincipal概念への言及・依存は皆無。
- `src/schema.sql:717` `principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT` を独立確認(PHASE9C-PREREQUISITES.md §2-2の記述と一致)。

### 推測にとどまる事項

- (推測) `http-transport.ts` が dead code であることは静的import/呼び出し関係の網羅的grepとpackage.json binエントリ確認に基づく結論であり、動的import(文字列組み立てによる遅延読み込み)が他のどこにも存在しない前提に立つ。全.ts/.js/.jsonファイル対象の動的import文字列grepは実施したが100%網羅性を主張するものではない。
- (推測) gbrain本番運用が実際に `gbrain serve --http` コマンド経由でのみ起動されている前提に立つ。リポジトリ外のデプロイスクリプト・カスタムラッパーが `http-transport.ts` を直接importして起動している場合、dead code結論は本リポジトリのソースコードには当てはまるが実運用環境には当てはまらない可能性がある。

### 未確認事項

- `docs/PRODUCTION-DEPLOYMENT.md` や実際の本番起動コマンド等、リポジトリ外のデプロイ構成は未確認(範囲外のため意図的に未調査)。
- adminセッション経由の操作(`/admin/api/register-client` 等)が `mcp_request_log` やその他監査テーブルに何らかの形で記録されているかは、この節の調査範囲(Identity/Auth構築経路)外(→ §4で確認)。
- `principal_kinds` テーブル自体のスキーマ定義・5種類のkindの妥当性検証は未実施(担当範囲外)。

### Phase 9C設計文書との対応

「3つのAuthInfo構築サイトのうち帰属可能なのは(a)のみ」「(b)は最強権限かつ帰属不能」「(c)は本番到達不能なdead code」「adminセッション・GitHub Webhookはそもそも別の認証平面」という事実群が、Opus設計 `unattributed_state_model`(11状態、特に `legacy_credential`・`admin_session`・`message_authenticated` の分離)と `domain_model`(`channel_id`/`attribution_state` を登録表参照にする設計)の直接の根拠になっている。

---

## 4. Protocol/Entry Point別の監査有無

### 確認済み事実

- POST `/mcp`・`/mcp-v2`(line1916起動)は tools/list成功(1941)・tools/call未知op拒否(1981)・スコープ不足拒否(2020)・op.handler内エラー(2116)・toolResult.isError(2148)・成功(2170)の全分岐で `mcp_request_log` へのINSERTを試行する。いずれもtry/catchでbest-effort・失敗silent。
- POST `/ingest`(2263-2453)は成功時(202、job投入完了、2404-2412)のみ `mcp_request_log`(`operation='webhook_ingest'`, `status='success'`)へ記録する。バリデーション拒否(400 empty_body 2290/2313、415 unsupported_content_type 2335/2344、400 invalid_event 2376)およびキュー投入失敗(500、2431-2434、console.errorのみ)は監査テーブルへのINSERTが**一切ない**。
- POST `/webhooks/github`(2479-2605)は401 missing_signature/webhook_not_configured/signature_mismatch、202 ignored、400 empty_body/malformed_json/missing_fields、404 unknown_repo、500 lookup_failed/queue_submission_failed、202成功、の全分岐を確認したが、ハンドラ全体に `mcp_request_log` その他監査テーブルへのINSERTは**0件**。
- `/admin/api/*`(requireAdminのみをゲートとする合計18ルート: mutatingルート7件+読み取り専用GETルート11件、1387-1827行付近)は、api-keys発行/失効・register-client・update-client-ttl・revoke-client・sign-out-everywhereを含む全mutating操作(7件)について、`mcp_request_log` へのINSERTが**0件**(唯一のINSERTは `access_tokens` テーブルへのAPIキー行作成そのものであり監査記録ではない)。なお、admin Authority状態を変更するルートとしては、`/admin/api/*` 外の管理セッション確立2経路(POST `/admin/login`・GET `/admin/auth/:token`)を加えた合計9ルートとして扱う。この2経路は `/admin/api/*` プレフィックス外であるため、上記18ルート(mutating7件+GET11件)の算術には含まれない。
- `src/mcp/server.ts`(`gbrain serve` を `--http` 未指定で起動した際のstdio MCPエントリポイント)は、ファイル全体(149行)を通読した結果、`mcp_request_log` へのINSERT・`broadcastEvent` 呼び出し・その他いかなる監査記録も**一切存在しない**。
- `src/mcp/server.ts` の `CallToolRequestSchema` ハンドラは「stdio MCP has no per-token auth (local pipe)」であり、`dispatchToolCall` をauth未指定で直接呼ぶ。`src/core/scope.ts` の冒頭コメントは `authorizeOperation`/`hasScope` の呼び出し元を `src/commands/serve-http.ts` のみと明記しており、`src/mcp/server.ts`/`src/mcp/dispatch.ts` へのgrepは0件。**stdio MCP経由の呼び出しはスコープベースの認可判定自体を一切経由しない**。
- `gbrain call <op>`(`src/mcp/server.ts` の `handleToolCall`、129-148行)も監査記録・スコープ認可のいずれも経由しない。`grep -rn "INSERT INTO mcp_request_log" src/commands/*.ts` は0件であり、CLI(`gbrain <command>`)全体が引き続き無監査であることを再確認した。
- Phase9A系文書5件全てに対し `grep -n -i "stdio"` を実行した結果、**1件もヒットしなかった**。stdio MCPエントリポイント(`src/mcp/server.ts`)はPhase9A系の調査対象から完全に漏れていた。
- POST `/token`(745,776)・POST `/revoke`(844)は、gbrain独自のOAuth 2.1トークン交換・失効ハンドラである。当該範囲(700-900行)をgrepした結果、`INSERT INTO`・`audit` いずれの文字列も**0件**であり、成功・失敗いずれの分岐にも監査テーブルへの書込は存在しない。
- `src/core/oauth-provider.ts` は `oauth_clients`・`oauth_codes`・`oauth_tokens` テーブルへのINSERTのみを持ち、トークン発行/交換イベント自体を記録する専用の監査書込(`mcp_request_log` 等)は見当たらなかった。
- `serve-http.ts:1015-1196` に「Unit E-1(2026-07-24)」「Unit E-4(2026-07-24)」と明記された「TEMPORARY DIAGNOSTIC」ミドルウェアが存在する。コメントに「redacted OAuth handshake logging for a ChatGPT Connector "connection failed" investigation」と明記。`/authorize`・`/token`・discovery系3エンドポイントへのリクエスト受信・レスポンス確定を、`src/core/oauth-diagnostic.ts` の `oauthDiagLog()` 経由でJSONLファイルに記録する。フラグによるガードなしに常時 `app.use(...)` で登録されている(1023,1155行)。
- `src/core/oauth-diagnostic.ts`(67行)は `OAUTH_DIAGNOSTIC_LOG_PATH = '/Users/lab/Library/Logs/gbrain-oauth-diagnostic.jsonl'` というハードコード絶対パスに `appendFileSync`(mode 0o600)で追記する。`client_id` は `maskClientId()` で先頭8文字...末尾8文字にマスク。ファイル冒頭コメントに「Intended to be removed once root cause is confirmed」と明記。**現時点でOAuthトークン発行/交換イベントの唯一の観測手段がこの削除予定の一時診断モジュールである。**
- `submit_agent`(`operations.ts:3067-3221`)は、`ctx.remote===false`(CLIローカル)を即座に `invalid_request` で拒否し(3085-3087)、`ctx.auth?.clientId` が存在しない場合(3089-3091、stdio MCP経由は常にこれに該当)`permission_denied` で拒否する。binding不存在(3111-3113)、`boundTools===null`(3121-3126)、tool不許可(3131-3136)、`slug_prefix`不許可(3140-3146)、concurrency超過(3159-3164)の各拒否は、いずれも `logAgentSubmission` 呼び出し(3202、job投入成功後のみ到達)より**前**で発生する。
- HTTP `/mcp` 経由で `submit_agent` が拒否された場合、`dispatchToolCall` が返す `toolResult.isError=true` を `serve-http.ts` の `if(toolResult.isError)` 分岐(2136-2164)が捕捉し、`mcp_request_log` へ `status='error'`・`operation='submit_agent'` としてINSERTを試行する(コードトレースで確認)。**つまりHTTP経由の場合、拒否試行は `agent-audit.ts` 側のJSONLには記録されないが `mcp_request_log` 側には記録される。**
- 一方stdio MCP経由で `submit_agent` が呼ばれた場合は、`ctx.auth` が常にundefinedのため必ず `permission_denied` で拒否されるが、stdio transport自体が `mcp_request_log` への書込を一切持たないため、**この拒否は `mcp_request_log`・`agent-audit.ts` JSONLいずれにも記録されない**。
- `src/core/minions/self-fix.ts`(183-274行)は、`submitSelfFixChild` 成功時(217-224、`outcome='submitted'`)・失敗時(229-236、`outcome='failed_to_submit:...'`)の両方で `logSelfFixEvent()` を呼び、`migrate.ts` の migration v94(4324行)で作成された `minion_self_fix_log` テーブルへINSERTする(256-268、best-effort)。これは `mcp_request_log`・`agent-audit.ts` JSONLとは独立した**第3の永続監査機構**である。
- `PHASE9A-GAP-AND-ROADMAP.md` item9 は監査系統を「`mcp_request_log` + `agent-audit.ts` JSONL(2系統)」と記述しているが、`minion_self_fix_log` という少なくとも**第3の独立した永続監査テーブル**が存在することを確認した。
- `migrate.ts` をgrepした結果、`mcp_request_log`・`mcp_spend_log`・`take_nudge_log`・`minion_lease_pressure_log`・`minion_budget_log`・`minion_self_fix_log`・`migration_impact_log` という**7個の `*_log` テーブル**が存在する(CREATE TABLE IF NOT EXISTS一致箇所のみ、各テーブルの書込条件は未精査)。
- `mcp_request_log` の現行スキーマは `id, token_name, operation, latency_ms, status, created_at, agent_name, params, error_message` のみで、`principal_id`・`job_id` 列は存在しない(grep確認、PHASE9C-PREREQUISITES.md §2の記述と一致)。
- コード分岐としてのベンダー名判定(if文でClaude/ChatGPT等を分岐させるロジック)は今回の調査範囲では発見されなかった。ただしコメント・診断コードレベルでのベンダー名言及は複数確認: `/mcp-v2` ルート追加理由が「ChatGPT connector compatibility」(1910行)、GET `/mcp` が405を返す設計判断コメントに「claude.ai」名指し(1906行)、TEMPORARY DIAGNOSTICモジュール全体がChatGPT Connector固有の障害調査目的として明記。

### 推測にとどまる事項

- (推測) gbrain実運用環境が本調査対象の作業ツリーと完全に同一コード状態かどうかは未検証であり、本節は working tree の現状についての報告である(本番挙動そのものではない可能性)。
- (推測) TEMPORARY DIAGNOSTICミドルウェア(Unit E-1/E-4)は導入から本調査時点まで約9日経過しているが、これが「まだroot causeが未確定で意図的に残されている」のか「削除し忘れ」なのかはコード上の証跡だけでは判別できない。

### 未確認事項

- `oauth-provider.ts` の `exchangeClientCredentials`/`exchangeAuthorizationCode`/`exchangeRefreshToken`/`verifyConfidentialClientSecret` の内部実装は、監査系キーワード(INSERT INTO/audit)によるgrep確認のみで、全文の逐次読解は行っていない。`console.log` 等の非永続ログが内部に存在するかは未確認。
- `@modelcontextprotocol/sdk` 側の `mcpAuthRouter` が提供する `/register`(DCR)、公開PKCEクライアント向けの `/authorize`・`/token`・`/revoke` フォールバック経路の内部監査挙動はgbrainリポジトリ外のため未確認。
- `src/core/ingestion/daemon.ts` のfile-watcher/inbox-folder/cron-scheduler等daemon側が不正イベントを検知した際の実際の記録先は実装コード未読了のため未確認。
- `mcp_spend_log`・`take_nudge_log`・`minion_lease_pressure_log`・`minion_budget_log`・`migration_impact_log` の各テーブルについて、どの経路がいつ書き込み/読み取りするかは未精査(存在確認のみ)。
- 管理画面フロントエンド(`admin/src/pages/Agents.tsx` 等)の詳細実装は未読了。
- `oauth-diagnostic.ts` が書き込むJSONLファイルの実際のローテーション・保持期間・読み取りツールの有無は未確認。

### Phase 9C設計文書との対応

「監査ゼロの経路が `/token`・`/revoke`・`/webhooks/github`・`/admin/api/*`(mutating)・stdio・CLIに広範に存在すること」「監査系統が2でなく3(DB2+JSONL1)+15以上(運用診断JSONL)存在すること」「submit_agentの拒否記録がtransport(HTTP/stdio)により非対称であること」「OAuthトークン発行の唯一の観測手段が削除予定の一時診断モジュールであること」が、Opus設計 `scope_boundary`(IN: `/mcp`・`/mcp-v2`・`/ingest`拒否分岐・`/authorize`・`/token`・`/revoke`・admin9ルート・webhook・submit_agent、OUT: admin読み取り専用GET11ルート・stdio一般操作・ローカルCLI・15+運用診断JSONL)の直接の根拠になっている。

---

## 5. Schema/Migration機構

### 確認済み事実

- マイグレーション機構(`src/core/migrate.ts`): `MIGRATIONS: Migration[]` 配列にversion番号+SQL(+任意handler/verify)を埋め込み。`LATEST_VERSION = Math.max(...MIGRATIONS.map(m => m.version))`(5733-5735行)。現在の最大値は**125**(`principal_identity_foundation`、5674-5731行)。
- 適用順序: `runMigrations()`(6058-6181行)は昇順ソート後、`current`より大きいものだけを `pending` として順次適用。バージョンは `config` テーブルの単一キー `version`(スカラー整数文字列)で管理(5925-5926行)。各マイグレーションを個別に記録する `schema_migrations` 的な履歴テーブルは存在しない。
- 各マイグレーションはデフォルトでトランザクション内で実行される(`transaction?: boolean`、コメント29-33行、デフォルトtrue)。失敗時はバージョンが進まず次回リトライされる設計。
- **rollback(down方向)は一切存在しない**。`Migration` インターフェース(18-59行)にdown/rollbackに相当するフィールドは無い。リポジトリ全体grepでマイグレーション専用のdown実行機構・関数・CLIフラグはゼロ件。
- `gbrain apply-migrations --force-schema` は「schema-version drift(バージョンカウンタと実スキーマのズレ)をリセットしてrunMigrationsを再実行する」機能であり、down方向のロールバックではない(前進方向の再適用/強制修復)。
- `principal_kinds` 定義(`schema.sql:651-663` 等): `id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT`。オープンワールドregistryとしてINSERT ON CONFLICT DO NOTHINGで5種(human/service/agent/device/unknown)を初期投入。コメントで「新しいkindはINSERTで追加、スキーマ/マイグレーション変更では追加しない(AUTHZ-INV-015)」「認可コードはkind_id/labelで分岐してはならない(AUTHZ-INV-001)」と明記。
- `principals` 定義(`schema.sql:670-676`): `id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kind_id TEXT NOT NULL DEFAULT 'unknown' REFERENCES principal_kinds(id), display_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ`。コメント: 「Phase 9Bは基盤のみ。create/revoke APIは未公開、`revoked_at`は未使用、認可判定でprincipalsを読む経路はゼロ」「行は物理削除されない設計」。
- `oauth_clients.principal_id` 定義(`schema.sql:717`): `principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT`。**SET NULLではなくRESTRICT**を選んだ理由がコメントに明記(712-716行): 「principals行は物理削除されない設計だが、万一削除された場合に監査用の参照を無言で失わせず、削除自体を拒否するため」。`PHASE9C-PREREQUISITES.md §2-2` はPhase 9Cで同種FKを追加する際も同じ設計(RESTRICT)の踏襲を推奨している。
- `idx_oauth_clients_principal_id`(`schema.sql:732-733`): `CREATE INDEX IF NOT EXISTS idx_oauth_clients_principal_id ON oauth_clients(principal_id) WHERE principal_id IS NOT NULL`(部分インデックス)。
- v125マイグレーション本文コメント(5688-5701行)には、当初handler-onlyで実装されていたため `runMigrationSQLWithRetry` の3回リトライ・`statement_timeout` 上書き・57014/MigrationRetryExhausted診断パスをスキップしてしまっていた不具合が内部レビューで発覚し、`sql:` へ移動して他の全マイグレーションと同じ安全ラッパーを受けるよう修正された、という経緯が記録されている。
- `principal_kinds`/`principals`/`oauth_clients.principal_id` について、型定義・FK句・ON DELETE句・インデックスは `src/schema.sql`(Postgres向けfresh install)・`src/core/pglite-schema.ts`(PGLite向けfresh install)・`src/core/schema-embedded.ts`(`bun run build:schema` で自動生成)の3ファイルで完全一致(diffなし)。`test/e2e/schema-drift.test.ts` が3ファイル間の同期を強制する。
- `PostgresEngine#applyForwardReferenceBootstrap`(475-1022行)と `PGLiteEngine#applyForwardReferenceBootstrap`(457-990行)は、どちらも `needsPrincipalIdBootstrap` フラグで `principal_kinds`/`principals` テーブルの存在と `oauth_clients.principal_id` カラムの存在を1回のprobe SELECTでチェックし、不足していればv125と全く同一のSQLを `SCHEMA_SQL` replay「前」に実行する。両エンジンのbootstrap SQLは文字列レベルで完全一致。
- bootstrapが必要な理由(コメント): `SCHEMA_SQL` 自体は `CREATE TABLE IF NOT EXISTS` のため既存テーブルにカラムを追加しない。しかし `SCHEMA_SQL` 末尾の `CREATE INDEX idx_oauth_clients_principal_id ON oauth_clients(principal_id) ...` は `principal_id` カラムの存在を前提とするため、v125未適用の既存brainでそのままreplayするとこの `CREATE INDEX` でクラッシュする。bootstrapはこれを防ぐため先回りする。
- `initSchema()` 全体の実行順序: (1) `pg_advisory_lock(42)` 取得 → (2) `applyForwardReferenceBootstrap` → (3) `SCHEMA_SQL` を `conn.unsafe()` でreplay → (4) `runMigrations` でpending migrationsを順次適用 → (5) `verifySchema` で不足カラムを自己修復。
- `token_name → oauth_clients.client_id` の対応関係はコードパスにより性質が異なる。(A) OAuth経由: `token_name = authInfo.clientId = row.client_id`(`oauth_clients.client_id` のFK先と文字列として完全一致)。(B) レガシー `access_tokens` 経由(oauth-provider.ts内): `clientId = name`(`access_tokens.name`、`oauth_clients` とは無関係な別ID空間)。(C) `http-transport.ts` 側の独立レガシーパス: `tokenName = rowName`(`access_tokens.name`)、これも `oauth_clients.client_id` とは無関係。**この対応はFK/CHECK制約による保証ではなく、アプリケーションコードの「慣習」でしかない。**
- 既存の同種バックフィル前例(v33、`migrate.ts:1517-1560`、特に1545-1551行): `mcp_request_log.agent_name` カラム追加時に `UPDATE ... SET agent_name = COALESCE((SELECT client_name FROM oauth_clients WHERE client_id = m.token_name), (SELECT name FROM access_tokens WHERE name = m.token_name), m.token_name)` という3段階COALESCEパターンが既に実装されている。
- `mcp_spend_log`(v77、3185-3237行、schema.sql/pglite-schema.tsにはインラインで存在せずmigrate.ts経由でのみ追加)は `client_id TEXT` と `token_name TEXT` を別カラムとして両方持つが、どちらもFK制約なし。`mcp_request_log` とは別テーブルで、監査統合スコープと明示的に指定されてはいないが構造的に類似の課題を抱える隣接テーブル。
- `schema-verify.ts`(全文読了): `initSchema()` 最終段で `SCHEMA_SQL` をパースして期待カラム一覧を再構築し、実DBの `information_schema.columns` と突合、不足カラムを自己修復(`ALTER TABLE ADD COLUMN`)する仕組み。`simplifyColumnDef()`(129-148行、特に133行)が `REFERENCES ...` 句(ON DELETE/UPDATE込み)を**正規表現で除去**してからADD COLUMNする実装になっている(既知の負債 `dashboard-r3be4` と一致)。到達条件(bootstrapが先に走るため通常は発火しない)自体の再現・非再現の動的検証はしていない(未確認)。
- `PHASE9C-PREREQUISITES.md`(2026-08-02付)は「実装を含まない・設計はPhase 9C着手時にarchitectエージェント等で別途行う」と明言しており、Phase 9Cの詳細設計(マイグレーション番号・バックフィルSQL)自体はStage1時点ではまだコード化されていなかった。

### 推測にとどまる事項

- (推測) `mcp_request_log.token_name` の実データにおいて、OAuth経由の行とレガシー `access_tokens` 経由の行の割合がどの程度かは実DBを見ていないため不明。3経路とも現役で稼働しているため両方の行が混在している可能性が高いと推測されるが未確認。
- (推測) `schema-verify.ts` のFK剥落自己修復パスが実運用で過去に発火した実績があるかは、静的挙動としては確認したが実際のインシデント有無は未確認。

### 未確認事項

- 実データベースへの接続・クエリは行っていないため、`mcp_request_log` の実際の行数・`token_name` の実データ分布・既にNULL/不正値が混入している行の有無は未確認。
- `mcp_request_log.job_id` について、コード上のカラム自体が現状存在しないことのみ確認し、将来どういう形で追加される想定かの一次資料までは深掘りしていない。
- `PostgresEngine`/`PGLiteEngine` 以外にengine実装(テスト用モック等)が存在するかは未確認。
- `verifySchema()` のFK剥落自己修復パスの発火条件(PgBouncer transaction-mode特有のレース条件下での再現性)は動的な再現テストを実施していない。
- `mcp_spend_log` がPhase 9Cのスコープに含まれるかは `PHASE9C-PREREQUISITES.md` に明記が無く未確定。

### Phase 9C設計文書との対応

「rollback機構が存在せずforward-onlyであること」「`principal_id` FKがRESTRICTを採用した前例と理由」「PGLite/Postgres/schema-embeddedの3ファイル同期パターンとそれを保証するテスト」「v33 COALESCEバックフィル前例とその限界(token_nameだけでは経路を判別できない)」「`simplifyColumnDef` によるFK剥落既知欠陥」が、Opus設計 `migration_and_schema_plan`(v126〜v128、FK例外3件の根拠、bootstrap順序を崩さない設計)と `backfill_migration_plan`(token_name文字列一致backfillを採らない理由、書き込み時点でのAuthInfo直接取得という代替案)の直接の根拠になっている。

---

## 6. 既存テスト資産

### 確認済み事実

- Phase 9B関連の指定9テストファイルは全て `test/` 配下に実在: `test/authorization-invariant-matrix.test.ts`(446行)、`test/e2e/principal-postgres.test.ts`(374行)、`test/oauth-fallback-pre-phase9b.test.ts`(385行)、`test/principal-identity-foundation.test.ts`(226行)、`test/principal-rollback-pglite.test.ts`(230行)、`test/principal-schema-parity.test.ts`(214行)、`test/e2e/postgres-bootstrap.test.ts`(191行)、`test/schema-bootstrap-coverage.test.ts`(907行)、`test/minions-shell.test.ts`(366行)。
- `test/authorization-invariant-matrix.test.ts` はPrincipal 8状態(`principal_id=null`/human/service/agent/device/unknown/robot(実行時追加kind)/human-revoked)× read/write/agent/adminスコープの認可不変性を、本番の実ゲート `src/core/scope.ts` の `authorizeOperation()` を**直接import**して検証する(冒頭コメント: 過去はserve-http.tsの手写しreproductionだったが、本番からのドリフトリスクのため実関数呼び出しに置換済み)。7 describeブロック・49テスト。
- `test/e2e/principal-postgres.test.ts` は実Postgres(`docker-compose.test.yml`、localhost:5434、`DATABASE_URL`未設定時はskip)でPrincipal基盤(fresh schema、v124→v125 migration、FK、ON DELETE RESTRICT、OAuth発行/検証、`revoked_at`、手動rollback SQL、fresh/migrated schema parity)を検証する。
- `test/oauth-fallback-pre-phase9b.test.ts` は `verifyAccessToken()` のフォールバック連鎖を7つの人工的pre-migration DB状態ごとに個別 `beforeAll` で検証し、`isUndefinedTableError(err, table)` のnarrowing2テストを含む計9テスト。
- `test/principal-identity-foundation.test.ts` はユーザー指定10項目の最低要求チェックを13テストでカバーする。
- `test/principal-rollback-pglite.test.ts` は `PHASE9B-MIGRATION-AND-ROLLBACK.md §4-2` の手動rollback SQLを `DOCUMENTED_ROLLBACK_SQL` 定数として **そのまま** PGLiteに `engine.db.exec()` 実行し、config.version巻き戻し・Phase9Bオブジェクト消失・rollback前登録Clientの認証存続(`principalId`/`principalKind`=undefinedへ縮退)・`initSchema()` 再実行での完全復元、の4テストを持つ。
- `test/principal-schema-parity.test.ts` は fresh PGLiteエンジンと、fully-init後にPhase 9Bオブジェクトを剥離し `config.version='124'` へ巻き戻して `initSchema()` 再実行した「migrated」PGLiteエンジンとを、`test/helpers/schema-diff.ts` で列/Index/FKを機械比較し完全一致を確認する1テスト。
- `test/e2e/postgres-bootstrap.test.ts`・`test/schema-bootstrap-coverage.test.ts` はいずれもPhase 9B専用ファイルではなく既存の汎用ファイルで、それぞれ2テスト・3エントリ(`REQUIRED_BOOTSTRAP_COVERAGE`配列)をPhase 9Bが追加する形で拡張している。
- `test/minions-shell.test.ts` はPhase 9Bと直接関係しないが、検証作業中に `describe('shell-audit: write')` 内の `GBRAIN_AUDIT_DIR` 環境変数のsave/restoreバグ(無条件delete、294-301行付近)が発見・修正された。
- `test/core/retry.test.ts` を単体実行した結果、**36 pass / 1 fail**。失敗は `BATCH_AUDIT_SITES typed enum + isBatchAuditSite guard (D10c codex) > list contains all CEO + eng + codex callers`。`src/core/retry.ts` の `BATCH_AUDIT_SITES` 定数(75-105行)には `'mcp.put_page.remote_auto'` が含まれる(94行)一方、テストの期待値Setにはこのエントリが欠落している。`PHASE9B-TEST-EVIDENCE.md §14-3` が記載する既知baseline失敗(Beads `dashboard-2vepx`)と完全一致することを直接確認した。
- `test/scripts/run-unit-parallel.test.ts` を単体実行した結果、**4 pass / 2 fail**。失敗はラッパー自己テスト2件(exit codeの期待値不一致)。`PHASE9B-TEST-EVIDENCE.md §14-3` の既知baseline失敗(Beads `dashboard-nc8tl`)と件数・内容が一致。
- 上記2件のbaseline既知失敗は、Phase 9Bの変更(`src/`配下のM14件)を一切適用していない部分(`retry.ts`・`run-unit-parallel.sh`はいずれも無変更=Mに含まれない)でも再現するため、**Phase 9B由来ではなく既存の独立したドリフト/バグ**であることが確認された。
- Phase 9B専用6ファイル+OAuth回帰4ファイルを計10ファイル同時実行した結果、**201 pass / 0 fail / 837 expect() calls**。`PHASE9B-TEST-EVIDENCE.md §13-3` が記載する数値と完全一致。
- `test/minions-shell.test.ts` と `test/audit/audit-dir-preload.test.ts` を同時実行した結果、**43 pass / 0 fail / 72 expect() calls**。`PHASE9B-TEST-EVIDENCE.md §3-9-a` の記載と一致し、`GBRAIN_AUDIT_DIR`隔離バグの修正が現在機能していることを確認した。
- `bash scripts/check-test-isolation.sh` を実行した結果、唯一の違反として `test/put-page-remote-auto.test.ts` の rule R1(process.env mutation)違反が1件のみ検出された。`PHASE9B-TEST-EVIDENCE.md §12-1` の記載と一致。
- `scripts/run-unit-parallel.sh`(全文読了)は、CPU数検出でシャード数を決定(既定4、8超は8にクランプ)、各シャードを `${GBRAIN_TEST_SHARD_TIMEOUT:-1500}` 秒(既定25分)でラップして並列起動し、完了後に `*.serial.test.ts` を `--max-concurrency=1` で直列実行する構成。
- `package.json` のtestスクリプトは `test`(=run-unit-parallel.sh)、`test:full`、`test:e2e`、`test:slow`、`test:heavy`、`test:profile`、`test:serial` に分かれている。
- `scripts/check-test-isolation.sh` は非serial並列テストファイルに対しR1(process.env変更禁止)・R2(mock.module禁止)・R3(PGLiteEngine生成はbeforeAll直下50行以内)・R4(disconnect必須)の4ルールを強制するCIガードで、`*.serial.test.ts` と `test/e2e/**` はスコープ外。
- `src/schema.sql` の `mcp_request_log` テーブル定義には現時点で `principal_id`・`job_id` 列は存在しない(再確認)。
- `PHASE9B-IMPLEMENTATION-REPORT.md:79` に「`mcp_request_log.job_id`(Phase 9Cへ)」という記載があり、Phase 9BがこのカラムをスコープAへ意図的に含めず、Phase 9Cの対象として明示的に先送りしていることを確認した。
- `PHASE9B-REVIEW-MANIFEST.md §10` に「Phase 9C(Audit Event統合): principalsテーブルが既に存在するため、`mcp_request_log` への `principal_id` 参照FK追加は素直に乗る」という記載があることを確認した。
- 9テストファイルに対し `claude|anthropic|chatgpt|openai|gpt-` をgrepした結果、実質的な製品名・ベンダー名による分岐コードは**0件**だった(唯一のヒットは `test/principal-schema-parity.test.ts:20` のコメント内「CLAUDE.md」というファイル名言及)。

### 推測にとどまる事項

- (推測) `PHASE9B-TEST-EVIDENCE.md §14-3` が記載する他の既知flakyテスト(`hybrid-meta.serial.test.ts` 等5ファイル)も現在も再現する可能性が高いが、本調査ではこれらを実行して独立確認していない。
- (推測) `rc=143` 問題の根本原因(`gtimeout × SHARD_TIMEOUT=1500s` のSIGTERM)は、スクリプトの定数値確認により文書の説明と整合はしているが、実際に25分超のシャード実行を再現してSIGTERM発生を直接観測したわけではない。

### 未確認事項

- `test/e2e/principal-postgres.test.ts` と `test/e2e/postgres-bootstrap.test.ts` の現在の実行結果(実Postgres実機)は、Docker/`DATABASE_URL`を用意していないため未実行。
- `scripts/run-unit-parallel.sh`(フルUnitスイート本体)および `scripts/run-serial-tests.sh`(90ファイル規模)の現在の完走結果は、実行に数十分規模を要するため未実行。
- `test/schema-bootstrap-coverage.test.ts`(907行)・`test/minions-shell.test.ts`(366行)の全文は一部しか読んでおらず、網羅的レビューは行っていない。

### Phase 9C設計文書との対応

「Phase 9Bが確立した4点セット(feature-identity-foundation/e2e-postgres/schema-parity/rollback-pglite)のパターン」「baseline既知失敗2件が独立ドリフトでありPhase 9B/9Cとは無関係であること」「機械diffによるbaseline取得が必須手順であること(v1→v7訂正の主因の再発防止)」「`authorization-invariant-matrix.test.ts` が実ゲートを直接importする設計」が、Opus設計 `test_strategy`(4点セット踏襲+Phase9C固有3領域の追加、`audit-*` 命名統一、baseline運用のテスト名レベル機械diff)の直接の根拠になっている。

---

## 7. 先行設計文書とBeads技術的負債

### 確認済み事実

- `PHASE9A-IDENTITY-MODEL-DECISION.md` は「Subjectは独立概念として採用せず、Principal(新規)+Client(既存oauth_clients)の2層構造とする」ことを確定している(§0/§2-1)。gbrain内部に `subjects` テーブルは作らない。
- 同文書§1-1aで、Principal種別(kind)の保存方式は固定CHECK制約(案A)ではなく `principal_kinds` 登録テーブル参照(案C)を採用と確定。初期データはhuman/service/agent/device/unknownの5行。
- 同文書§1-1bで、Phase 9Bは完全加算的・認可挙動不変とし、Principal失効(`revoked_at`)は認証・認可のいかなる判定にも入力されない、Phase 9BではPrincipal失効操作を行う製品機能を一切公開しない、と明記。
- 同文書§7で、Phase 9Bは「案A: 基盤のみ」を採用。Principal作成・紐付けを行うUI/API/CLIは実装せず、全既存Clientの `principal_id` はnullのままとなることを意図した設計として明記。
- `PHASE9A-AUTHORIZATION-INVARIANTS.md` はAUTHZ-INV-001〜015の15項目を定義。**AUTHZ-INV-009**は「委任チェーンは監査で再構成できる」ことを要求し、理由として現状 `mcp_request_log` と `agent-audit.ts` のJSONLが相互参照されておらず委任チェーンの再構成が不可能であることを明記し、この欠落解消を**Phase 9Cの到達目標**として明示している。
- AUTHZ-INV-005〜008は委任(Delegation)の権限narrowing・失効伝播・有効期限・再委任(孫委任)に関する不変条件だが、AUTHZ-INV-008の解説文中で「現状は孫委任の手段自体が存在しない」ため予防的条件であるとされている。
- `PHASE9A-GAP-AND-ROADMAP.md §7` で、Phase 9系列の依存順序案が示されている: Phase 9C(Audit Event統合)はPhase 9Bに依存(「Principal概念が確定していないとFK先が定まらない」)。Phase 9G(Organization/Tenant)はPhase 9B〜9F全てに依存し、最後に配置。Phase 9GがPhase 9Cに依存する方向であり、逆方向の記述はない。同文書§7の脚注で「本セクションはPhase 9A時点でのSonnetによる提案であり、確定した実装計画ではない」と明記されている。
- `PHASE9A-TARGET-DOMAIN-MODEL.md §6`(Delegation)は、`submit_agent`/`AgentClientBindings` が「クライアント→ジョブ」の1階層のみを扱い、孫委任は現状不可能と明記。`PHASE9A-SUPPLEMENTAL-AUDIT.md §4-2〜4-3` は、`submit_agent`(operations.ts当時3155-3169付近)がparent_job_idを渡さないこと、およびsubagentのツールレジストリ(`brain-allowlist.ts`)にsubmit_agent自体が含まれない(grep 0件)ことを実装追跡で確認済みと明記している。
- working tree上の実コードを独立検証した結果、`operations.ts:3193-3198` の `submit_agent` の `queue.add()` 呼び出しに `parent_job_id` は渡されておらず、`brain-allowlist.ts` に `submit_agent` という文字列は0件だった。**ドキュメントの主張はPhase 9B実装後の現行working tree上でも成立している。**
- `src/schema.sql` に `organization_id`/`tenant_id` という列名は存在しない(grep 0件)。`principals` テーブル(670-676行)にもこれらの列はない。
- `PHASE9C-PREREQUISITES.md §2-1` は、`principal_id`・`kind_id`・`revoked_at` のいずれもスコープベースの認可判定に影響を与えないことがPhase 9B全体を通じて最も重要な不変条件であり、Phase 9Cで監査ログにPrincipal情報を統合する際もこの不変条件を破らないことが絶対条件、と明記している。
- `PHASE9C-PREREQUISITES.md §2-2` は、`oauth_clients.principal_id` のFKがON DELETE RESTRICTであり(v5内部レビューでSET NULLから変更)、Phase 9Cで `mcp_request_log` に同様のFKを追加する場合は同じ設計を踏襲することを推奨、としている。
- `PHASE9C-PREREQUISITES.md §2-3` は、AuthInfoが(a)OAuthパス、(b)レガシー`access_tokens`パス、(c)`http-transport.ts`のレガシーパスの3箇所で構築され、Principal帰属を持てるのは(a)のみであり、特に(b)は `scopes: ['read','write','admin']` を無条件に返すため「最も強い権限を持つ経路が最も帰属不可能」と明記している。
- `PHASE9C-PREREQUISITES.md §3` は、内部レビューで発見されPhase 9Bスコープ外としてBeadsへ登録した技術的負債8件を一覧化しており、いずれも優先度P3〜P4・ブロッカーではない、と明記している。Beads実取得(`bd show`)により、8件すべてが実際に存在し、状態はいずれも「○ OPEN」(未着手)、優先度は `feibe`/`ikosb`/`m1ja3`/`vg25p`/`r3be4` がP3、`84p97`/`5qp17`/`bvz6l` がP4であることを確認した。

| Beads ID | 内容 | 優先度 | Phase 9Cとの関連 |
|---|---|---|---|
| `dashboard-feibe` | pre-v125 brainで `verifyAccessToken` の認証往復が2倍 | P3 | 識別情報の列を追加する前にproviderインスタンス上でメモ化する構造修正が推奨 |
| `dashboard-ikosb` | `verifyAccessToken` にキャッシュが無く将来のJOIN追加が乗算的にコスト増 | P3 | Phase 9Cがこの関数(監査ログ書き込みを含む可能性が高い)に触れる前にtokenHashキーの短TTLキャッシュ追加を検討すべき |
| `dashboard-m1ja3` | `principals`/`principal_kinds` がv24 RLS backfillの静的管理リストに未登録 | P3 | パフォーマンスではなくDB/セキュリティ観点での判断が必要。HANDOVER.md §13に「実機では既に成立していない可能性がある」との追加所見あり(未検証) |
| `dashboard-84p97` | `probe as unknown as` キャストが型安全性を迂回 | P4 | Phase 9Cでこの領域に触れる際に置き換えを検討(非ブロッキング) |
| `dashboard-5qp17` | Scope型がoperations.ts/scope.tsで3重定義 | P4 | Phase 9Cで新しいoperationやscopeを追加する前に統一を推奨(非ブロッキング) |
| `dashboard-vg25p` | `apply-migrations --force-schema` が `pg_advisory_lock(42)` を取らない | P3 | Phase 9Bとは無関係の既存欠陥。Phase 9Cのマイグレーション追加時、ロールバック直後の運用手順との相互作用に注意 |
| `dashboard-bvz6l` | `principals.revoked_at` がどこからも参照されていない | P4 | Phase 9B時点では無害だが、将来principalを認可判断に組み込む際の罠になりうる |
| `dashboard-r3be4` | Postgres側verifySchemaのself-heal経路がFK句を除去し `principal_id` をFKなしで復元しうる | P3 | 現状はbootstrapが先に走るため到達しないが、Phase 9Cでbootstrap順序に変更を加える場合は要再確認 |

- `HANDOVER.md`(v1.2、最終更新2026-08-02)によれば、Stage1調査時点の状態は「Phase 9B完了(外部承認取得済み、Beads `dashboard-vyyod` CLOSED)」「Phase 9C進行中(Beads `dashboard-zz21x`、IN_PROGRESS、Stage1調査着手)」であった。
- `dashboard-zz21x`(Phase 9C親タスク)はP0・IN_PROGRESS、Stage1(調査,並列)→Stage2(Opus設計)→Stage3(設計文書7点)→...→Stage8(Review Bundle v1)の8段階進行計画が明記。Stage1時点でPhase 9C配下の子Beadsタスクは `dashboard-zz21x` 以外に存在しない(`bd list` で1件のみ)。
- `dashboard-vyyod`(Phase 9B親タスク)は実際に✓CLOSEDであり、NOTESに「外部監査(ChatGPT)がPhase 9B Review Bundle v7を正式承認」と記載されている。
- `HANDOVER.md §7`・git実行結果により、**Stage1調査時点の**working treeには34件の未コミット変更(M14+??20)が存在し、HEAD=`6906ab998201...`であることが記載と実測(`git status --short`・`git rev-parse HEAD`)で一致した。すなわちPhase 9BのPrincipal基盤実装は、Stage1調査時点では実リポジトリへ一切コミットされておらず、working tree上にのみ存在する状態でPhase 9Cが着手されていた。**この状況は §1(a) のユーザー確定事項により、現在は独立コミット(`fcdb7c47d34696a1cb23fb79e878978dc0c23186`)として解消済みである。**
- `HANDOVER.md §8`(設計原則)は、AUTHZ-INV-001〜004・FK方針(ON DELETE RESTRICT)・3経路中2経路が構造的にPrincipal帰属不可能、を「Phase 9A/9Bで確立した設計原則」としてPhase 9C以降も踏襲すべきものと明記している。
- `HANDOVER.md §14` は、次セッションが最初に `git status --short`・`git rev-parse HEAD`・`bd show dashboard-zz21x` を実行し記載内容と一致確認してから作業開始することを義務付けている。
- 独立コード検証: `scope.ts`/`operations.ts` をgrepした結果、Claude/ChatGPT/Anthropic/OpenAI/Gemini等のベンダー名・製品名に基づく認可分岐コードは見つからなかった(該当したのはLLMモデル選択のフォールバック文字列やコメントのみで、Capability判定への製品名分岐ではない)。「Universal設計を維持している」という主張と一致する。

### 推測にとどまる事項

- (推測) `HANDOVER.md §13` で言及されている `dashboard-m1ja3` の「実機では既に成立していない可能性」については、DB/セキュリティ担当による実機確認(RLS設定の実査)を行っておらず、Beads本文・HANDOVER記載をそのまま引用したに留まる。
- (推測) `PHASE9C-PREREQUISITES.md §4` のOrganization/Tenant順序判断は、過去のArchitecture Reviewerの所見の要約であり、そのReviewerの生の指摘内容(元レビュー記録)までは遡って確認していない。

### 未確認事項

- 8件のBeads技術的負債それぞれについて、Phase 9C設計判断の前に対応着手すべきかというユーザー/architectの優先度判断は、`PHASE9C-PREREQUISITES.md` 自体が「優先度は参考、いずれもブロッカーではない」としているのみで、確定的な結論は出ていない。
- `dashboard-m1ja3`(RLS非対称性)の実機での現在の状態は、DBに直接アクセスして確認していない。
- AUTHZ-INV-007(委任の有効期限が元Credentialの有効期限を超えない)について、`PHASE9A-AUTHORIZATION-INVARIANTS.md` 自体が「submit_agentのtimeout_msデフォルト値が固定されており、トークンTTLとの突き合わせは行っていない」と明記しており、独立検証していない。

### Phase 9C設計文書との対応

「AUTHZ-INV-009が委任チェーンの監査再構成をPhase 9Cの到達目標として明示していること」「Phase 9G(Organization/Tenant)はPhase 9Cに一方向で依存し、逆方向の制約はないこと」「Beads 8件がいずれも非ブロッカーだが `dashboard-feibe`/`dashboard-ikosb` はverifyAccessToken周辺に触れる以上初期検討価値が高いこと」が、Opus設計 `org_tenant_precedence`(9G先行不要の判定根拠)と `test_strategy`(`test/audit-delegation-chain.test.ts` によるAUTHZ-INV-009到達確認)の直接の根拠になっている。

---

## 8. Phase 9Cへの示唆(横断的まとめ)

Stage1の6エージェント調査を横断して読むと、単一エージェントの調査だけでは見えない構造的な問題が浮かび上がる。

### (1) `http-transport.ts` は本番到達不能なdead code

§3(Identity/Auth)と§4(Protocol/Entry Point)の双方が独立に確認: `startHttpTransport` を実際にimport/呼び出ししているのは2つのテストファイルのみで、本番コードパス(`src/cli.ts`・`src/commands/serve.ts`)からのimportは存在しない。`package.json` のbinエントリも `src/cli.ts` 単一のみ。この結論自体は `PHASE9A-EVIDENCE-MANIFEST.md:45`・`PHASE9A-SUPPLEMENTAL-AUDIT.md:247` が部分的に把握していたが、本調査(§3)がpackage.json binエントリの精査とテスト経由起動可能性の確認を追加して確定させた。Opus設計はこれを踏まえ、(c)経路(http-transport.tsのAuthInfo構築サイト)を「監査上優先すべきは(a)(b)の2経路のみ」と扱っている(§3参照)。

### (2) 監査ゼロの経路群が広範に存在する

§2・§4で確認した「INSERTが0件」の経路を列挙すると:

- POST `/token`・POST `/revoke`・GET/POST `/authorize`(資格情報発行/失効そのもの。唯一の観測手段は削除予定のTEMPORARY DIAGNOSTICモジュール `oauth-diagnostic.ts`)
- POST `/webhooks/github`(全分岐でINSERT 0件)
- admin Authority変更操作(合計9ルート: `/admin/api/*` 配下のmutating7ルート[api-keys発行/失効・register-client等を含む]+ `/admin/api/*` 外の管理セッション確立2ルート[POST `/admin/login`・GET `/admin/auth/:token`])
- POST `/ingest` のバリデーション拒否・キュー投入失敗(成功時のみ記録という非対称)
- stdio MCP経由の全操作(`src/mcp/server.ts` は監査記録を一切持たない)
- ローカルCLI(`gbrain call`、`gbrain <command>`)全体
- stdio経由の `submit_agent` 拒否(HTTP経由の拒否は `mcp_request_log` に記録されるが、stdio経由は`mcp_request_log`・`agent-audit.ts` JSONLいずれにも記録されない非対称性)

### (3) 監査系統は「2」ではなく「3+15以上」存在する

`PHASE9A-GAP-AND-ROADMAP.md` item9 は監査系統を「`mcp_request_log` + `agent-audit.ts` JSONL(2系統)」と記述しているが、Stage1は少なくとも以下を確認した:

- DB系: `mcp_request_log`、`minion_self_fix_log`(v94、self-fix成功/失敗の第3の独立監査テーブル)
- JSONL系(帰属・権限関連): `agent-audit.ts`
- JSONL系(運用診断、監査目的ではない): 少なくとも15個以上(調査時点で少なくとも18個を具体的に確認。ただし網羅的な全数調査ではなく、実際の該当モジュール数は28〜30個前後に及ぶ可能性がある。詳細は§2参照)の `*-audit.ts` 群(shell-audit, supervisor-audit, schema-pack系ほか)
- さらに `ingress-diagnostic.ts`・`oauth-diagnostic.ts` という2つの一時診断JSONLロガー(いずれも "TEMPORARY" と明記され削除予定)

Opus設計はこの実態を踏まえ、`jsonl_disposition` でクラスA(帰属・権限関連、Phase 9C対象)とクラスB(運用診断、T-todo-3所有領域)を明確に分離している。

### (4) T-todo-3(既存の負債登録)とのスコープ重複

`TODOS.md:2467` に記載のT-todo-3(「15個のJSONL監査モジュールをDBテーブルへ寄せる」、v0.40.4起票・未着手)は、`PHASE9C-PREREQUISITES.md` が想定する「`mcp_request_log` への `principal_id` FK追加」という狭いスコープとは規模が異なる隣接領域である。Opus設計の `scope_boundary` はこの重複を「主体の権限行使の試み、またはIdentity/Credential/Authorityの状態変化を記録するイベントか」という単一の判定基準で解消し、`jsonl_disposition` で「Phase 9Cは共通プリミティブ(durable spill writer等)を提供し、T-todo-3はそれを再利用する」という役割分担を明記している。唯一の例外は `agent-audit.ts`(submit_agent委任ログ)で、Phase 9CとT-todo-3の境界にまたがる唯一のモジュールとして両ドキュメントに相互記載する設計になっている。

### (5) OAuthトークン発行自体が一時診断モジュール頼み

§4で確認した通り、`/authorize`・`/token`・`/revoke`(資格情報のライフサイクルそのもの)には恒久的な監査経路が現状ゼロで、唯一の観測手段が「削除予定と明記されたTEMPORARY DIAGNOSTICモジュール」(`oauth-diagnostic.ts`、ハードコードされた開発者ローカルパスへの書込)である。この一時モジュールが削除されれば、資格情報発行イベントの記録は完全にゼロへ戻る。Opus設計はこれを監査価値が最も高い経路として `scope_boundary` のIN対象に明示的に含めている。

### (6) admin セッション確立2経路はStage1調査で見落とされていた

POST `/admin/login`(bootstrap token直接ログイン)・GET `/admin/auth/:token`(マジックリンク償還)というadminSessionsを確立する2経路は、本書のStage1調査(§1(c)・§4)では当初「Authority状態を変更する」対象の列挙から漏れていた。Round5レビュー(Reliability Reviewer)で発見され、Stage3設計文書側でIN対象(admin9ルート)へ是正済みである。

### 相互参照まとめ

| 本書の節 | Opus設計文書での主な反映先(フィールド名) |
|---|---|
| §2 監査ストレージ | `mcp_request_log_disposition`、`failure_policy`、`jsonl_disposition`、`migration_and_schema_plan`(保持期間) |
| §3 Identity/Auth経路 | `unattributed_state_model`、`domain_model`(channel_id/attribution_state) |
| §4 Protocol/Entry Point別監査 | `scope_boundary`(IN/OUT判定)、`jsonl_disposition`(クラスA) |
| §5 Schema/Migration機構 | `migration_and_schema_plan`、`backfill_migration_plan` |
| §6 既存テスト資産 | `test_strategy` |
| §7 先行設計文書とBeads技術的負債 | `org_tenant_precedence`、`test_strategy`(委任チェーンテスト) |

以上、本書はPhase 9Cの設計判断を一切行わず、Stage1で確認された事実の整理に徹した。設計そのものは後続の `PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md` 以下の各設計文書を正本とする。
