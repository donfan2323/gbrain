# Phase 9A補完監査 — 未確認コードパスの追加調査

**日付**: 2026-08-01
**位置づけ**: Phase 9Aの4文書(現状監査・目標モデル・ギャップ・証跡マニフェスト)に対する補完調査。既存監査の再実施ではなく、`PHASE9A-EVIDENCE-MANIFEST.md`§4で未確認とされた領域のうち、Phase 9B以降の設計へ直接影響する範囲のみを対象とする。
**方法**: 実ファイルの直接読み取り・grep調査のみ。推測で「〜と思われる」と書いた箇所は全て実装追跡により事実確認済み、または依然として未確認として明記。

---

## 1. 既存設計文書との整合性(1-1)

### 調査対象と結果

| ディレクトリ | ファイル数 | Principal/Subject/Identity/Actor/User/Account等の定義 |
|---|---|---|
| `docs/adr/` | 1件(`0001-single-binary-rejected.md`) | なし(単一バイナリ配布可否のADRで主体/認証とは無関係) |
| `docs/architecture/` | 14件 | なし。`thin-client.md`に"identity banner"という語があるが、UI上の表示ラベルであり認証・認可のドメイン概念ではない |
| `docs/designs/` | 8件 | `MINIONS_AGENT_ORCHESTRATION.md`に重要な記述あり(下記) |
| `docs/mcp/` | 8件 | 製品別セットアップ手順書のみ。認可判断の記述なし |

**結論**: Phase 9Aの4文書と矛盾する既存設計決定は見つからなかった。Principal/Subject/Identity/Actor/User/Accountをドメイン概念として定義した既存文書は存在しない。Phase 9Aが提案する用語は、既存文書上の用語と衝突しない。

### 重要な発見: `docs/designs/MINIONS_AGENT_ORCHESTRATION.md`

このドキュメント(`submit_agent`/`minion_jobs`機構そのものの設計文書)には、Phase 9Bの設計判断に直接影響する既存の意思決定が明記されていた。

1. **「v1はsingle-user, single-brain」であることが既に明文で確定していた**(261-263行目): 「NOT in v1 scope: Multi-tenant auth, cross-network connectivity, protocol versioning, API key isolation. These are Phase 2 concerns when actual multi-platform usage materializes. v1 is single-user, single-brain.」
   → これはPhase 9Aが「発見したギャップ」ではなく、gbrainチーム自身が**既に意図的に決定し文書化していた**スコープ境界である。`PHASE9A-GAP-AND-ROADMAP.md`のOrganization/Tenant(項目11・Phase 9G)は、この既存の意思決定と矛盾せず、むしろ整合する。

2. **「Phase 3: Multi-tenant auth」が既にgbrain自身のロードマップに存在する**(435-436行目): 「Phase 3: Multi-tenant auth — Runtime MCP access control, per-platform API keys. Enabled by: platform-agnostic framing, sender validation on inbox.」
   → 既存ADR・設計文書を上書きする必要はない。Phase 9Gの位置づけ(将来・優先度低)は、gbrain自身の既存計画と整合しており、追加のADRなしで両立する。

3. **提案された`AgentJobData.platform`フィールド(`'openclaw'|'hermes'|'claude-code'|'custom'`)は実装されていない**: `grep -rn "AgentJobData" src/`は0件。実装済みの`submit_agent`(`operations.ts`)・`subagent.ts`ハンドラのどちらにも`platform`相当のベンダー名フィールドは存在しない。
   → 設計時点で検討されたベンダー名ベースの分岐が、実装時に採用されなかったことを意味する。これはUniversal化の観点で**望ましい既成事実**であり、Phase 9Bで「vendor名分岐を排除する」という新規作業は不要(そもそも存在しない)。

4. **エージェントの実行ループはgbrainプロセス内に存在しない**(265-304行目、「Agent Handler Architecture」): 「The agent handler does NOT live in GBrain. GBrain provides the queue infrastructure and a clean handler contract. The actual agent execution lives in the platform plugin.」
   → `submit_agent`で投入されたジョブの実際のLLMループ実行(ツール呼び出しの詳細)は、外部プラットフォーム(OpenClaw等)のプロセス内で行われる。gbrain自身が観測できるのは、外部ハンドラが`updateProgress`/`log`/`readInbox`経由で能動的に報告した内容のみ。これは**Audit Eventの完全性に対する構造的な制約**であり、Phase 9B以降でAudit Eventモデルを設計する際に「gbrainは委任先の全アクションを本質的に観測できない」ことを前提とすべきという実務的知見である。

**後方互換性上、変更禁止・維持必須とされている契約**: 上記文書には、Phase 9Aの4文書が想定していない追加の互換性制約は見当たらなかった。既知のOAuth 2.1・MCP・Connector互換性以外に新たな制約は発見されていない。

**既存ADRを上書きする必要性**: なし。新規ADRの必要性: `PHASE9A-IDENTITY-MODEL-DECISION.md`の内容が正式採用される場合、Principal概念の導入をADRとして記録することが望ましいが、これはPhase 9B実装判断であり本補完監査の範囲外。

---

## 2. 管理画面の認証・認可・監査経路(1-2)

### 2-1. サーバ側

`src/commands/serve-http.ts`内の`/admin/api/*`ルート登録を全件確認した(grep結果、19ルート):

```
/admin/login, /admin/api/issue-magic-link, /admin/auth/:token,
/admin/api/sign-out-everywhere, /admin/api/agents, /admin/api/agents/spend,
/admin/api/stats, /admin/api/health-indicators, /admin/api/full-stats,
/admin/api/jobs/watch, /admin/api/calibration/pattern/:id,
/admin/api/calibration/profile, /admin/api/calibration/charts/:type,
/admin/api/requests, /admin/api/api-keys(GET/POST),
/admin/api/api-keys/revoke, /admin/api/register-client,
/admin/api/update-client-ttl, /admin/api/revoke-client, /admin/events
```

**事実確認**: ログイン系(`/admin/login`, `/admin/api/issue-magic-link`, `/admin/auth/:token`)を除く**全19ルートが例外なく同一の`requireAdmin`ミドルウェアのみ**を通過条件としている。`requireAdmin`通過後に操作別(read-only/destructive等)の認可分岐は**存在しない**(コード上に確認、推測ではない)。`register-client`(新規クライアント登録)と`revoke-client`(クライアント無効化)という性質の異なる操作が、`stats`(統計閲覧)と全く同じゲート一つで保護されている。

**操作者識別**: `requireAdmin`はbootstrap-token由来の`adminSessions`(インメモリMap)を照合するのみで、「誰が」ログインしたかを区別する情報(氏名・アカウントID等)を一切保持しない。複数の人間が同じbootstrap tokenを共有した場合、サーバ側は全員を同一の匿名「admin」として扱う。

**セッション追跡**: `adminSessions`はセッションごとに個別のトークン/Cookie値を持つため、技術的には「セッションA」「セッションB」を区別する能力はある(`sign-out-everywhere`は全セッションを一括失効させる実装のはず)。しかし、どのセッションが「誰の」ものかを紐付ける情報は存在しないため、個別追跡は「セッション識別子レベル」に留まり「操作者識別」には至らない。

### 2-2. フロントエンド側

`admin/src/pages/Login.tsx`・`admin/src/api.ts`を全文確認した。

- ログイン画面はbootstrap tokenの入力欄1つのみ。ユーザー名・アカウント選択・ロール選択のUIは存在しない。
- コード内コメント(v0.26.3 trust model, D11+D12)に明記: 「The bootstrap token is NEVER stored in browser JS state... the operator's token only lives in the HttpOnly cookie」。設計として意図的に「単一の匿名operator」モデルを採用しており、見落としではない。
- `api.ts`は`/admin/api/*`への全呼び出しを単純にラップしているのみで、クライアント側にも権限差分・ロール概念は存在しない。

### 2-3. 監査記録の有無(最重要の新規発見)

`grep -n "INSERT INTO mcp_request_log" src/`の全結果(7箇所、すべて`serve-http.ts`の1941/1981/2013/2109/2141/2163/2400行目)を確認したところ、**いずれも`/mcp`・`/mcp-v2`・`/ingest`ハンドラ内にあり、`/admin/api/*`ルート(1231-1877行目)には1件も存在しない**。

**確認された事実**: 管理画面から実行される操作(クライアント登録・無効化・API key発行/無効化・TTL変更を含む)は、**`mcp_request_log`にも、他のいかなる永続的監査テーブルにも一切記録されない**。管理画面の`admin/src/pages/RequestLog.tsx`は`mcp_request_log`の列(`token_name`/`agent_name`/`operation`/`status`等)をそのまま表示するのみであり、そもそも記録されていない管理画面自身の操作を表示する手段を持たない。

これは「管理画面は別系統だから危険」という結論を先取りしたものではなく、**grep + コード読解による直接確認済みの事実**である。Phase 9Aの原文書は「管理画面は認可コアの外側にある」ことまでは指摘していたが、「管理画面操作が一切監査記録されない」という事実までは確認していなかった。

### 2-4. 管理画面操作とMCP/HTTP operationの対応関係

| 管理画面操作 | 対応するMCP operation |
|---|---|
| `register-client` / `update-client-ttl` / `revoke-client` / `api-keys` (作成/失効) | **なし**。クライアントのライフサイクル管理はMCP operationとして公開されておらず、管理画面が唯一のインターフェース |
| `stats` / `health-indicators` / `full-stats` / `jobs/watch` / `requests` | 対応するMCP operationはないが、いずれも読み取り専用の可観測性機能 |
| `calibration/*` | `mcp__gbrain__get_calibration_profile`等、MCP側にも同等の読み取り操作が存在(データ閲覧の二重経路) |

### 2-5. 共通Policy Decisionへの統合可能性の評価

「管理画面は別系統だから危険」と先に結論づけないという指示に従い、統合の実現可能性を事実ベースで評価する。

**統合を妨げる技術的障害は見当たらない**: `requireAdmin`はExpressミドルウェアとして`hasScope`ベースの検証に置き換え可能な形をしている。bootstrap-token検証結果を`AuthInfo`相当の構造(例: `{clientId: 'admin-bootstrap', scopes: ['admin']}`)にマッピングし、既存の`hasScope`経路へ流す設計は、既存コードの構造上、技術的には可能である。現在の分離は歴史的経緯(bootstrap tokenがOAuthスコープ体系より前から存在する)によるものであり、アーキテクチャ上の必然ではない。

**独立レーンとして維持する場合に必要な最低条件**(統合しない場合の安全条件): (a) 管理画面の全mutating操作(register/revoke/update-ttl/api-keys)を何らかの監査テーブルへ記録すること(現状ゼロ)、(b) 複数人が運用する可能性がある場合はセッションと操作者の紐付けを持つこと、(c) 少なくとも「管理画面操作の監査が存在しない」ことを既知のリスクとして明示的に文書化すること。

---

## 3. 監査ログの実際の書き込み経路(1-3)

`grep -n "INSERT INTO mcp_request_log"`の全7サイトと`src/mcp/http-transport.ts`の1サイトを実装追跡した。加えて、**当初のPhase 9A文書が把握していなかった、主体認証とは異なるメッセージ真正性検証機構**を発見した(下記3-5)。

### 3-1. `/mcp`・`/mcp-v2` (POST, `serve-http.ts:1916`)

| 分岐 | 認証 | 認可 | 操作者/Client識別 | Credential識別 | Session識別 | Execution Instance識別 | Delegation元識別 | 記録 | ログ失敗時挙動 |
|---|---|---|---|---|---|---|---|---|---|
| `tools/list` | ✓(requireBearerAuth) | N/A | ✓(clientId+agentName) | ✗ | ✗ | ✗(相関ID列なし) | N/A | ✓成功記録 | try/catchで握りつぶし(silent) |
| `tools/call` 未知op | ✓ | ✗(拒否前) | ✓ | ✗ | ✗ | ✗ | N/A | ✓拒否記録(status=error) | silent |
| `tools/call` スコープ不足 | ✓ | ✓(拒否) | ✓ | ✗ | ✗ | ✗ | N/A | ✓拒否記録 | silent |
| `tools/call` dispatch例外 | ✓ | ✓(通過後の例外) | ✓ | ✗ | ✗ | ✗ | ✗(submit_agent以外は該当なし) | ✓失敗記録 | silent |
| `tools/call` 成功 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | N/A | ✓成功記録 | silent |

### 3-2. `/ingest` (POST, `serve-http.ts:2259`)

| 分岐 | 記録 |
|---|---|
| 成功(キュー投入完了) | ✓記録(`webhook_ingest`, status=success) |
| バリデーション拒否(空body/415/400系、2282-2342行目) | **✗記録なし**。HTTPレスポンスのみ返し、監査テーブルへの書き込み試行自体がない |
| キュー投入失敗(500、2421-2428行目) | **✗記録なし**。`console.error`のみ、監査テーブル未記録 |

**新規発見**: `/ingest`は`/mcp`と異なり、**拒否・失敗系統を一切監査記録しない非対称設計**になっている。これは推測ではなくコード上に確認済みの事実(該当箇所にINSERT呼び出し自体が存在しない)。

### 3-3. CLI (`gbrain <command>`)

`grep -rn "INSERT INTO mcp_request_log" src/commands/*.ts`は**0件**。CLIから実行されるいかなる操作も`mcp_request_log`に一切書き込まれない。これは`ctx.remote===false`のCLI呼び出し箇所(以下3-6参照)を全数確認した上での事実。

### 3-4. 管理画面

上記2-3の通り、**0件**。

### 3-5. 新規発見: `POST /webhooks/github`(主体認証ではなくメッセージ真正性検証)

`serve-http.ts:2472`にOAuthともbearerトークンとも無関係な、**構造的に異なるカテゴリの検証機構**を発見した。GitHub Webhookは`X-Hub-Signature-256`ヘッダのHMAC-SHA256署名(`sources.config.webhook_secret`とのHMAC比較、`safeHexEqual`使用)で検証される、ソース単位の共有シークレット方式。

**分類の判断(2026-08-01確定)**: 本機構を「第4の主体認証系統」として数えるべきか検討した結果、**数えない**と判断した。理由: (a) `AuthInfo`相当の構造を生成しない、(b) `hasScope()`によるCapability判定に到達しない、(c) Session概念が成立しない(1回限りのペイロード検証)、(d) 識別対象がClient/Principalではなく`sources`行(データ提供元)である。これは「主体(誰が接続してきたか)を確立する」認証ではなく、「メッセージが改ざんされていないことを確認する」真正性検証であり、性質が異なる。したがって、gbrainの主体認証は**引き続き3系統**(OAuth／レガシーbearer／管理画面セッション)であり、Webhook HMACはこれとは別カテゴリの機構として記録する。詳細な比較は`PHASE9A-CURRENT-STATE-AUDIT.md`§2「認証機構の分類」を参照。

- 認証: ✓(HMAC署名、per-source secret)
- 認可: ✓(署名一致 + `event=push`のみ受理)
- 操作者/Client識別: `oauth_clients.client_id`ではなく`sources.id`のみ。人間・AI・サービスいずれの主体表現にも該当しない、**ソース(データ提供元)としての識別のみ**
- 監査記録: `grep`で該当ハンドラ全体(2472-2630行目付近)を確認した結果、**mcp_request_logにもいかなる監査テーブルにも一切記録されない**(0件)

Phase 9Aの原文書は「認証機構(主体認証)は3系統」としており、この分類とカウントは今回の補完監査でも維持する。Webhook HMAC署名は主体認証とは異なる「メッセージ真正性検証」という別カテゴリの機構であり、3系統に加算しない(§3-5参照)。既存4文書には、この分類自体を明記する追記のみを行う(§6参照)。

### 3-6. `submit_agent`(delegation entry point)

| 項目 | 内容 |
|---|---|
| 認証 | ✓(OAuth, `agent`スコープ) |
| 認可 | ✓(binding row存在 + bound_tools/bound_slug_prefixesのサブセット検証) |
| Client識別 | ✓(`clientId`) |
| Delegation元識別 | ✓ — ただし`mcp_request_log`ではなく**別系統のJSONLファイル**(`agent-audit.ts`)にのみ記録 |
| 成功記録 | ✓(JSONL、`outcome: 'submitted'`) |
| **拒否記録(permission_denied)** | **✗記録なし** — `logAgentSubmission`呼び出しは正常系(job投入成功後)のコードパスにのみ存在し、binding不存在・tool不許可・concurrency超過等の`permission_denied`/`rate_limited`throwは、そのthrow地点より前に発生するため`logAgentSubmission`に到達しない。**submit_agentの拒否試行は一切監査記録されない**(新規確認事実) |
| ログ失敗時挙動 | silent(`catch { /* never block submission */ }`) |

### 3-7. 実行中のsubagentジョブ自体

ジョブの`stacktrace`(JSONB)に外部ハンドラが能動的に記録した内容のみが残る。gbrain自身はLLMループの個々のツール呼び出しを直接観測しない(§1のアーキテクチャ制約を参照)。`job_id`が実質的なExecution Instance識別子として機能するが、`mcp_request_log`側のsubmit_agent呼び出し行とは相互参照されていない(`job_id`列は`mcp_request_log`に存在しない)。

---

## 4. ネストした委任・孫委任の実態(1-4)

**確認方法**: `parent_job_id`の全参照箇所(`queue.ts`, `types.ts`, `self-fix.ts`, `agent.ts`, `subagent.ts`, `brain-allowlist.ts`)を実装追跡した。

### 4-1. 一般的なジョブキュー機構としては、階層構造をサポートしている(事実)

`src/core/minions/types.ts:150`: 「Max parent→child→grandchild depth. Default 5. Enforced on add() with parent_job_id.」— `MinionQueue.add()`(`queue.ts:214-242`)は`parent_job_id`が指定されると、(a) 親の存在確認、(b) `depth = parent.depth + 1`が`maxSpawnDepth`(既定5)を超えないことの検証、(c) 親の`max_children`上限に対する現在の生存子数チェック、を行う。**これは汎用のジョブキュー機能であり、agent委任専用ではない**。

### 4-2. しかし`submit_agent`(OAuthで認可された委任の唯一の入口)は`parent_job_id`を一切使用しない(事実)

`operations.ts:3155-3169`の`jobData`/`queue.add()`呼び出しを全文確認した結果、`parent_job_id`は渡されていない。**`submit_agent`経由で投入されるジョブは常にトップレベル(親なし)である。**

### 4-3. 実行中のsubagentジョブは`submit_agent`を再度呼び出すツールを持たない(事実)

`subagent.ts:269-279`のツールレジストリは`buildBrainTools`/`filterAllowedTools`(`brain-allowlist.ts`)で構築される。`grep -n "submit_agent" brain-allowlist.ts`は**0件**。つまり、実行中のsubagentの内部ツールループには`submit_agent`が選択肢として存在せず、**孫ジョブを生成する手段自体がない**。

### 4-4. `parent_job_id`を実際に使うのは内部専用の別機構のみ

- `self-fix.ts:211`: `{ parent_job_id: parent.id, max_attempts: 1 }` — システムの自己修復ジョブ(単一試行、権限委任とは無関係の内部メンテナンス機構)
- `agent.ts:298`(CLI `gbrain agent run`のaggregatorパターン): `parent_job_id: aggregator.id` — **ローカルCLI専用**のマニフェスト一括実行機能。`ctx.remote===false`の文脈でのみ動作し、`allowProtectedSubmit: true`でOAuthバインディング検証自体を経由しない

### 4-5. 結論(事実、推測ではない)

- **OAuthで認可された委任経路(`submit_agent`)には、現時点でネスト/孫委任は実装されていない。** 委任は1階層(Client→Job)に限定されているというPhase 9A原文書の記述は、実装追跡により**事実として確認された**(旧文書では「推測(要検証)」だった)。
- 孫委任が技術的に不可能なのは意図的制限ではなく、「ツールとして選べない」「呼び出し元が`parent_job_id`を渡さない」という2つの実装上の結果であり、明文化された禁止ポリシーではない。将来`submit_agent`をsubagentの許可ツールに加えるような変更があれば、この制約は破られうる。
- `on_child_fail`・`max_children`・budget-tracker等の委任チェーン管理機構は存在するが、いずれもリソースガバナンス(同時実行数・コスト)目的であり、権限の再narrowingを目的にしていない。現状はそれで問題ない、なぜなら再narrowingが必要な階層構造自体が発生しないため。
- **委任チェーンを監査で再構成できるか**: 現状不可能。`__owner_client_id`(JSONB内、非正規化)が唯一の逆参照であり、`mcp_request_log`とも`agent-audit.ts`のJSONLとも相互参照されていない。

---

## 5. CLI・ローカル内部実行の信頼境界(1-5)

**確認方法**: `ctx.remote`の全設定箇所・全参照箇所(`operations.ts`内80箇所以上、`src/commands/*.ts`内の`remote: false`設定箇所30件以上)をgrepで洗い出し、代表箇所を読解した。

### 5-1. `ctx.remote`はOSレベルの識別子ではなく、コードパスのハードコードされたリテラル値である(事実)

`src/commands/advisor.ts:43`、`capture.ts:568`、`book-mirror.ts:522`、`calibration.ts:124`、`integrity.ts:443,650`、`enrich.ts:387`、`resolvers.ts:149`、`schema.ts`(7箇所)、`sync.ts:1775`、`import.ts:118`、`jobs.ts:404,2164`、`onboard.ts:239`、`whoknows.ts:339`等、30箇所以上で`remote: false`が**コード内の固定リテラル**として設定されている。OSのユーザーID(`process.getuid()`)・プロセス所有者・ソケットのpeer credential等を検証しているコードは、これらの箇所には一切存在しない。

対して`remote: true`は`serve-http.ts:2082`(HTTP/MCPハンドラ)のみで設定される。

### 5-2. gbrain自身が「信頼境界はOSである」と明記している(直接引用)

`operations.ts:2491-2492`(advisor operationのコメント): 「Local (ctx.remote === false) callers bypass — the trust boundary is the OS.」

これはgbrainの設計者自身による一次資料であり、Phase 9Aが外部から推測した評価ではない。gbrainはCLI呼び出しに対して**追加の身元確認を一切行わず、「gbrainバイナリをこのプロセスとして実行できたこと自体」をもって信頼する**設計を意図的に採用している。

### 5-3. `ctx.remote===false`は極めて広範な認可判断の分岐点になっている(事実)

`grep -n "ctx\.remote" operations.ts`は80件以上ヒットし、以下の判断に関与する: ソーススコープ制限のバイパス(486,491行目)、データソース可視性フィルタ(526-591行目)、`life/diary/`コンテンツの除外解除(5315行目)、advisor/doctorのpublish gate(2491-2492行目)、スキルディレクトリの閉じ込め解除(5145-5146行目)、`submit_agent`のローカル拒否(3056行目)、image path アクセス(4510,4525-4537行目)、矛盾解決の可視性(5379行目)など。**一つのブール値が、機能的にバラバラな数十箇所の認可判断を横断的に支配している。**

### 5-4. ローカル利用者のOSアカウント識別

存在しない(確認済み)。`whoami`相当のOSユーザー名取得や、プロセスの実行者UIDを認可判断に使うコードは、確認した範囲で見つからなかった。

### 5-5. 将来のコンテナ・共有ホスト・CI/CD・リモートシェルに対する含意(現状記述のみ、提案ではない)

`ctx.remote===false`はコードパス(「CLIコマンドとして呼ばれたか」)にのみ依存し、実行環境(コンテナ内か、共有ホスト上か、CI/CDジョブとしてか、SSH経由のリモートシェルからか)を一切区別しない。したがって、将来これらの環境で`gbrain`コマンドが実行される場合、その実行が「単一の信頼された人間オペレーターの意図」を表しているかどうかに関わらず、**現在と全く同じ、上記5-3に列挙した全ての認可バイパスが一律に有効になる**。これは現状の設計の忠実な記述であり、OAuth化等の対応策の提案ではない(ユーザー指示の通り)。

### 5-6. CLIは`mcp_request_log`に一切書き込まない

§3-3で確認済み。

---

## 6. 以前の推測が事実確認でどう変わったか(サマリ)

| Phase 9A原文書の記述 | 分類(旧) | 今回の確認結果 | 分類(新) |
|---|---|---|---|
| 「認証方式(主体認証)は実質3系統」 | 事実(調査範囲内) | 分類基準を確認した結果、**3系統という数え方は正しい**。ただし主体認証とは別カテゴリの「メッセージ真正性検証」機構(GitHub Webhook HMAC署名)が別途存在することを発見し、この分類の明記を既存文書に追記した | 事実誤認ではなく、分類の明示不足(追記により解消) |
| 「CLIローカル実行が`mcp_request_log`を経由しない可能性が高い」 | 推測 | 0件のCLI発INSERTを確認 → **経由しないことが事実として確定** | 事実(確認済み) |
| 「孫委任の権限継承ロジックは未確認」 | 推測(要検証) | `submit_agent`は`parent_job_id`不使用、subagentツールに`submit_agent`なし → **孫委任は現状不可能なことが確認済み** | 事実(確認済み) |
| 「管理画面はスコープモデルの外側」 | 事実 | 加えて**管理画ムの操作は一切監査記録されないことを新規確認** | 事実(範囲拡大) |
| 「`/ingest`の監査挙動」 | 未言及 | **拒否・失敗系統は監査記録されない非対称設計であることを新規発見** | 新規事実 |
| 「`submit_agent`の拒否試行の監査」 | 未言及 | **permission_denied等の拒否は一切監査記録されないことを新規発見** | 新規事実 |

---

## 7. 未確認のまま残る領域

- `admin/src/pages/Agents.tsx`・`Dashboard.tsx`・`Calibration.tsx`・`JobsWatch.tsx`の詳細実装(本補完監査ではLogin.tsx/api.ts/RequestLog.tsxのみ精読。他ページは一覧上の存在確認のみ)。
- `adminSessions`の実データ構造(Map値の型)は未読了。「sign-out-everywhere」が本当に全セッションを一括失効させる実装になっているかはコード未確認(ルート登録のみ確認、ハンドラ本体は未読)。
- `@modelcontextprotocol/sdk`側のインターフェース契約詳細(gbrainリポジトリ外のため範囲外、変わらず)。
- `evals/`, `examples/`ディレクトリ(内容未調査、変わらず)。
- `src/mcp/http-transport.ts`が真にdead codeであること(全importer 0件は確認したが、`package.json`のbinエントリやテストからの直接起動可能性までは確認していない)。
- 分散/共有ホスト環境で実際にgbrainが動かされた実績があるかどうか(§5-5は静的コード解析のみに基づく記述であり、実運用環境での検証は行っていない)。
