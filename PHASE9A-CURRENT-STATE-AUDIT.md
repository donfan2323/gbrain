# Phase 9A — 現状監査: gbrain の主体・認証・認可・監査・プロトコル依存

**日付**: 2026-07-31
**対象**: `/Users/lab/AI_Workspace/gbrain`(git管理下の本番ソース。読み取りのみ、変更なし)
**方法**: 実ファイルの直接読み取り・grep調査。根拠のない推測は記載していません。未確認領域は`PHASE9A-EVIDENCE-MANIFEST.md`に明示します。

---

## 0. 総括（先に結論)

gbrainの認証・認可コア（`oauth-provider.ts`/`scope.ts`/`operations.ts`）自体には、製品名・ベンダー名による分岐は**存在しません**。スコープモデルはプロトコル非依存の6値フラット階層（read/write/admin/sources_admin/users_admin/agent）で、MCP(`/mcp`,`/mcp-v2`)・HTTP(`/ingest`)いずれも同一の`requireBearerAuth({verifier: oauthProvider})`を通過します。

一方で、**主体（Principal/Session/Credential等）を区別する統一ドメインモデルは存在しません**(この現状記述自体は事実であり、後述のPrincipal導入是非とは独立に維持される。「Subject」を独立概念とするかどうかの判断は`PHASE9A-IDENTITY-MODEL-DECISION.md`で確定済み — 不採用・Principal/Clientの2層に統合、を参照)。`AuthInfo`型（`operations.ts:264`）は「トークン＋クライアントID＋スコープ＋データソース権限」のみを表現し、それを保持しているのが人間か、AIエージェントか、サービスかを区別する型はどこにもありません。さらに、**gbrainには構造の異なる3種類の認証機構が並存**しています（OAuth 2.1／レガシーbearerトークン／管理画面のインメモリセッションCookie）。マルチテナント・組織概念は存在せず、PGLiteは「single-tenant by design」と明記されています。委任（delegation）は`submit_agent`一箇所に限定的に実装されており、権限の絞り込み（narrowing）自体は実際に機能しますが、監査証跡は「ベストエフォートのJSONLファイル」であり、DBに問い合わせ可能な形にはなっていません。

---

## 1. 主体の表現

| 概念 | 現状 | 根拠 |
|---|---|---|
| 人間 | 明示的な型なし。管理画面ログインを行う操作者が事実上「人間」だが、コード上は「admin session cookie」としてのみ表現される | `serve-http.ts:1364-1377`(`requireAdmin`) |
| サービス | 明示的な型なし。OAuthクライアント(`oauth_clients`)がサービス的client_credentialsクライアントを兼ねる | `oauth-provider.ts` |
| AIまたはエージェント | 明示的な型なし。`agent`スコープを持つOAuthクライアントが実質的に「エージェント許可済みクライアント」だが、「AIクライアントである」ことを示す専用フィールドはない | `scope.ts:25`(`Scope`列挙に`'agent'`はあるが主体種別ではなくケイパビリティ) |
| デバイス | 概念自体が存在しない | (該当箇所なし) |
| 実行インスタンス | `minion_jobs`が「ジョブ実行」の単位を持つが、これは委任先エージェントの実行インスタンスであり、接続クライアント自体の実行インスタンス(セッション)ではない | `schema.sql:873-920` |
| クライアント | `oauth_clients`テーブルが唯一の一貫した表現。`client_id`/`client_name`/`scope`/`source_id`/`federated_read`/`bound_*`列を持つ | `schema.sql:642-664` |
| セッション | OAuthには専用の「セッション」概念がなく、トークン(`oauth_tokens`)自体がセッションの代替。**管理画面だけ**別に`adminSessions`という名前のインメモリセッション(Map、DB永続化なし)を持つ | `schema.sql:673-681`, `serve-http.ts:1364-1391` |
| 資格情報 | `oauth_clients.client_secret_hash`、`oauth_tokens.token_hash`、`access_tokens.token_hash`の3種。ハッシュのみ保存(平文は登録時に一度だけ返却) | `schema.sql:612-620,642-681` |
| 委任先 | `oauth_clients.bound_*`列(bound_tools/bound_source_id/bound_slug_prefixes/bound_max_concurrent/budget_usd_per_day)。ジョブ側は`minion_jobs.data->>'__owner_client_id'`というJSONB内の非正規化フィールドで逆参照 | `schema.sql:656-663`, `operations.ts:3160,3127` |

**判定**: 混同ではなく「未分化」。各概念に対応するテーブル/型が場当たり的に存在するが、これらを束ねる上位の`Principal`型は存在しません(`types.ts`1671行には知識コンテンツドメイン型のみが定義され、主体系の型は皆無)。この欠落を埋める設計として`Principal`(新規)+`Client`(既存`oauth_clients`)の2層構造を採用することが`PHASE9A-IDENTITY-MODEL-DECISION.md`で確定している(`Subject`という第3の概念は同文書で不採用と判断された)。

---

## 2. 認証

| 認証方式 | 実装場所 | ドメインモデルへの依存 |
|---|---|---|
| OAuth 2.1 (authorization_code+PKCE / client_credentials) | `src/core/oauth-provider.ts`(1100行) — `@modelcontextprotocol/sdk`の`OAuthServerProvider`を実装 | `oauth_clients`/`oauth_tokens`/`oauth_codes`テーブルに直結。`scope.ts`のスコープ集合に依存 |
| APIキー/レガシーbearerトークン | `access_tokens`テーブル(`schema.sql:612-620`)。`verifyAccessToken`が両テーブルをフォールバック的に見る(Phase8調査で確認済み、`oauth-provider.ts:727-781`相当) | 同上。DCR前からの後方互換専用 |
| CLI認証(`gbrain auth register-client`) | `src/commands/auth.ts`(606行) | 直接DB接続で`oauth_clients`へINSERT。本番稼働中インスタンスへの実行はPGLiteロック競合を起こす既知の問題(Phase8で実測済み) |
| MCP認証 | `requireBearerAuth({verifier: oauthProvider})`を`/mcp`・`/mcp-v2`両方に適用(`serve-http.ts:1916`)。**2つのエンドポイントで検証器が完全に同一** | oauth-provider.ts一本 |
| HTTP認証(`/ingest`) | 同じく`requireBearerAuth({verifier: oauthProvider, requiredScopes: ['write']})`(`serve-http.ts:2259`) | 同上 |
| 管理画面(`/admin/api/*`)認証 | **上記いずれとも独立した第3の機構**。`GBRAIN_ADMIN_BOOTSTRAP_TOKEN`環境変数 → magic-link → `adminSessions`というインメモリMap(サーバ再起動で消滅、DB永続化なし) | `oauth_clients`等とは無関係。`serve-http.ts:1364-1391` |
| GitHub Webhook(`POST /webhooks/github`) | `X-Hub-Signature-256`ヘッダのHMAC-SHA256署名を`sources.config.webhook_secret`と比較(`safeHexEqual`使用)。**主体認証ではなくメッセージ真正性検証**(下記「認証機構の分類」参照) | `oauth_clients`/`AuthInfo`のいずれとも無関係。`sources`テーブルのみに直結。`serve-http.ts:2472-`(Phase 9A補完監査で新規確認) |
| ローカル接続 | `ctx.remote === false`という真偽値フラグで判定(`operations.ts:3056`)。ローカルCLI呼び出しは`submit_agent`等リモート専用オペレーションで拒否されるが、これは「信頼するかどうか」ではなく「対象オペレーションの適用範囲」の切り分け | `operations.ts`各所の`ctx.remote`チェック |
| サーバー間通信 | 専用の実装は見当たらず。サーバー間もOAuth client_credentialsを使う設計(Phase8で確認したCodex-CLI/Hermes-Agent登録もこの型) | 上記OAuth 2.1と同一 |

**重要な発見**: **主体認証(誰が接続してきたかを確立し、Capability判定につなげる機構)は実質3系統**(OAuth／レガシーbearer／管理画面セッション)が並存しており、後者2つはOAuthの`scope`/`hasScope`モデルの外側にあります(レガシートークンは固定的に`['read','write','admin']`相当を持つとPhase8調査時点で確認済み、管理画面セッションはスコープという概念自体を持たない全権限モデル)。この「3系統」というカウントは初版から一貫しており、変更していません。

### 認証機構の分類 — 主体認証 とメッセージ真正性検証(Phase 9A補完監査で確定、2026-08-01)

Phase 9A補完監査で発見した`GitHub Webhook`のHMAC-SHA256署名検証を、上記「3系統」に加えて**第4の主体認証系統**として数えるべきか検討した結果、**数えない**と判断した。理由は以下の通り、Webhook HMACが構造的に異なるカテゴリ(メッセージ真正性検証)に属するためである。数を4にすることが目的ではなく、分類基準を一貫させることを優先する。

| 観点 | OAuth 2.1 / レガシーbearer / 管理画面セッション(主体認証、3系統) | GitHub Webhook HMAC(メッセージ真正性検証) |
|---|---|---|
| 何を証明するか | 「この接続の背後にいる主体が、登録済みの正当な保持者である」という**継続的な同一性** | 「この一回のペイロードが、共有シークレットを知る送信元から改ざんなく届いた」という**単発のメッセージ完全性** |
| `AuthInfo`相当の生成 | する(`clientId`/`scopes`等を持つ構造体) | **しない**(`authInfo`変数自体が存在しない実装) |
| Capability(`scope.ts`)判定への到達 | する(`hasScope()`を経由) | **しない**(`hasScope`呼び出し自体が存在しない) |
| Sessionの成立 | する(`oauth_tokens`/`adminSessions`) | **しない**(1リクエスト限りで終わる、継続的な有効期間の概念がない) |
| 対応する主体表現 | Client(`oauth_clients`行) | **Source**(`sources`行)。ClientでもPrincipalでもない、データ提供元としての識別のみ |
| 認可される対象 | 任意のMCP operation(scope次第) | ただ1種類の内部アクション(`sync`ジョブの投入)のみ、分岐の余地がない |
| 失敗時の扱い | 401 + `mcp_request_log`への拒否記録(webhookは記録なし、詳細は§4) | 401、監査記録なし |

**Principal/Client/Capabilityモデルにおける対応関係**: GitHub Webhook HMACは`PHASE9A-IDENTITY-MODEL-DECISION.md`のいずれの概念にも「主体」としては対応しない。それが証明するのは「送信元Sourceの真正性」であり、Principal(帰属先の人間・サービス)にもClient(登録済み統合)にも解決されない。強いて対応させるなら、`webhook_secret`はSourceに帰属する**Credential相当**(検証可能な秘密情報)だが、そこから先にSession・Execution Instance・Capability判定が続かない点で、他のCredentialとは扱いが本質的に異なる。したがって本書では**Webhook HMACを「主体認証」のカウントに含めず、別カテゴリ(メッセージ真正性検証)として記録する**方針を採用する。

---

## 3. 認可

スコープは`src/core/scope.ts`(193行)がSingle Source of Truth。6値のフラット階層(`read < write < admin`, `sources_admin`/`users_admin`/`agent`は独立した兄弟スコープ)。

| 操作カテゴリ | 認可方法 | 重複/迂回の有無 |
|---|---|---|
| 読み取り | `op.scope === 'read'`(大半のoperationsのデフォルト) | `hasScope`一箇所で判定、迂回経路未発見 |
| 書き込み | `op.scope === 'write'`。`put_page`等 | 同上 |
| 削除 | 専用の`delete`スコープは存在しない。`write`スコープに包含される(`scope.ts:61`で`write`は`read`のみを含意し、`delete`という別スコープはない) | **削除操作は書き込みと同じ権限レベル**。誤って書き込み許可のみのつもりが削除も許可してしまう設計上の粗さがある(推測ではなく`scope.ts`の実装事実として、deleteという概念自体が存在しない) |
| 管理操作 | `admin`スコープ。全スコープを含意する「エスケープハッチ」(`scope.ts:51`のコメントに明記) | admin一強、細分化なし |
| インポート/エクスポート | `sources_admin`(ソース管理系)がインポートに、他は`write`/`admin`に依存(未確認、要个別ファイル追跡) | 未確認 |
| 検索 | `read` | - |
| タイムライン | `read`/`write`に準拠(専用スコープなし) | - |
| リンク操作 | `write`に準拠 | - |
| エージェント委任(`submit_agent`) | `agent`スコープ(独立、adminからは非含意 — v0.38 D13で意図的に変更されたと明記、`scope.ts:54-58`) | **これは良い設計**: 既存adminクライアントが自動的にagent権限を得ない設計 |

**接続方式ごとの認可重複/迂回**: `/mcp`・`/mcp-v2`・`/ingest`いずれも同一の`oauthProvider`検証器を通るため、認可ロジック自体の重複は確認されませんでした(1系統に集約)。ただし前述の通り、**管理画面(`/admin/api/*`)はスコープモデルの外側**にあり、`requireAdmin`をパスすれば全操作が可能という別建ての認可系統です。これは「迂回」ではなく「別レイヤーの認可」ですが、Universal化の観点では「認可判断基準が統一されていない」ことを意味します。

---

## 4. 監査

| 追跡したい項目 | 現状 |
|---|---|
| 誰が | `mcp_request_log.token_name` / `agent_name`(いずれも文字列、`oauth_clients.client_id`へのFK制約なし)。管理画面UI自体は`token_name = c.client_id`という一致を前提にクエリしている(`serve-http.ts:1400-1401`)ため、運用上は事実上client_idが入る規約になっているが、**スキーマレベルでは強制されていない** |
| どのクライアントから | 同上。`mcp_request_log`に`client_id`という正式なFK列は存在しない |
| どの資格情報で | 追跡不可。どのトークン(の具体的な発行インスタンス)が使われたかを`mcp_request_log`から遡れる列はない |
| どのセッションで | 該当なし(セッション概念自体がOAuth側にない) |
| 何を | `mcp_request_log.operation`列 |
| 誰の権限または委任で | `submit_agent`経路のみ、`logAgentSubmission`(`operations.ts:3172-3188`、実装は`src/core/minions/agent-audit.ts`)が`client_id`/`bound_tools`/`bound_source`等を記録。**ただしJSONLファイルへのベストエフォート書き込みであり、書き込み失敗は握りつぶされ(`catch { /* never block submission */ }`)、DBに問い合わせ可能な形では保存されない** |

**判定**: 監査は「操作ログ(`mcp_request_log`、DBテーブル、SQL照会可能)」と「委任ログ(JSONLファイル、ベストエフォート)」の2系統に分かれており、いずれも主体(client_id)への参照がFK制約で保証されていません。クライアントがdeleteされても過去ログの`token_name`文字列は残りますが、それが「本当にそのクライアントの操作だったか」をスキーマレベルで保証する仕組みはありません。

---

## 5. プロトコル依存

| 接続方式 | 知識コアへの結合度 | 認証への結合度 | 認可への結合度 | 監査への結合度 |
|---|---|---|---|---|
| MCP(`/mcp`,`/mcp-v2`) | Operation registry(`operations.ts`)経由の間接呼び出し。直接結合なし | `requireBearerAuth`共有(直結合ではなく共通ミドルウェア経由) | `op.scope`+`hasScope`共有 | `mcp_request_log`へ書き込み(実装箇所は未読了、要追加確認) |
| HTTP(`/ingest`ほか) | 同上、Operationレジストリ経由 | 同上 | `requiredScopes: ['write']`固定 | 未確認 |
| CLI(`gbrain auth register-client`等) | 直接DB接続(`withConfiguredSql`相当、Phase8で確認済み) | 独自(OAuth検証器を経由しない、オペレーター信頼前提) | CLI経由は検証バイパス(コメントに「CLI registration path trusts the operator and bypasses this gate」と明記、`oauth-provider.ts:133`) | 該当ログ機構は未確認 |
| 内部関数呼び出し(ローカルCLI経由の`gbrain` コマンド全般) | Operationレジストリを直接呼ぶ、または`ctx.remote===false`分岐 | 認証なし(信頼されたローカル実行前提) | 一部オペレーション(`submit_agent`)はローカル呼び出し自体を拒否 | **ローカル実行は`mcp_request_log`を一切通らない(確認済み、2026-08-01 Phase 9A補完監査)**。`src/commands/*.ts`全体を`INSERT INTO mcp_request_log`でgrepした結果は0件。詳細は`PHASE9A-SUPPLEMENTAL-AUDIT.md`§5-6 |
| SDK相当 | `@modelcontextprotocol/sdk`への直接依存(`OAuthServerProvider`実装、`bearerAuth`ミドルウェア) | SDKのインターフェース契約に強く依存 | - | - |

**判定**: MCP/HTTPの2大プロトコルは認証・認可を共有しており、これは良好(Universal化に近い)。CLIは意図的に検証をバイパスする設計(ローカル操作者を信頼する前提)であり、これは「プロトコルアダプターが認可を迂回できる設計」に**部分的に該当する可能性**があります。ただしCLIはリモートネットワークから到達不能なローカル実行に限定されるため、単純な「迂回」ではなく「信頼境界の異なる実行コンテキスト」という整理が妥当です。

---

## 6. 製品・ベンダー依存

grep調査の結果、`src/`配下の150以上のファイルがベンダー名(claude/chatgpt/gemini/anthropic/openai等)を含みますが、その**大多数はgbrain自身が呼び出すLLMプロバイダ選択(埋め込み生成・要約・エージェント実行のための外部AI呼び出し)に関するもの**であり、「接続してくるクライアントの認証・認可判断」とは別軸です(例: `src/core/ai/recipes/anthropic.ts`, `openai.ts`, `google.ts`等は全てgbrainが**発信**するAI API呼び出しの実装で、Universal Knowledge Layerが問題にしている「誰が接続してきたか」の判断には使われていません)。

クライアント接続に関わるベンダー名の実例:

| ファイル | 内容 | 認証・認可への影響 |
|---|---|---|
| `src/commands/connect.ts:50-67` | `AgentId = 'claude-code' \| 'codex' \| 'perplexity' \| 'generic'`。`AGENT_SPECS`でCLIごとの設定生成分岐 | **なし**。このファイルはクライアント側の設定スニペット生成ヘルパー(人間が貼り付けるMCP設定テキストを出す)であり、サーバ起動時にロードされない。認証・認可の判断には一切関与しない |
| `oauth-provider.ts`冒頭コメント(1-14行目) | 「ChatGPT向け」「Perplexity/Claude向け」等、grant typeの想定利用者をドキュメントコメントとして記載 | **なし**(コード分岐ではなくコメント) |
| `docs/mcp/CODEX.md`, `docs/mcp/CLAUDE_CODE.md` | 製品別セットアップ手順書 | **なし**(ドキュメントのみ) |

**判定**: 認証・認可コア(`oauth-provider.ts`/`scope.ts`/`operations.ts`)に製品名分岐は確認されませんでした。唯一の実コード分岐は`connect.ts`というクライアント側ヘルパーCLIに限定され、これはサーバのリクエスト処理経路には含まれません。この構造は「製品差分をアダプター層に閉じ込める」というUniversal設計の理想形に近いと言えますが、`connect.ts`のAgentId列挙自体は依然として「既知の4製品」のハードコードであり、新製品(Gemini/Grok/Hermes)追加時にはこのファイルへの追記が必要です(認可コアではなく、あくまで利便ヘルパーの追記)。

---

## 7. マルチ主体・マルチ組織拡張性

| 項目 | 現状 |
|---|---|
| 単一ユーザー前提 | **明示的に存在**。PGLite(既定エンジン)は複数箇所で「single-tenant by design/construction」と明記(`migrate.ts:911,1688,2126`, `db-lock.ts:923`) |
| 共有管理者トークン | 管理画面は単一の`GBRAIN_ADMIN_BOOTSTRAP_TOKEN`ベース。複数管理者を区別する概念はなく、誰であれ同じbootstrap tokenから発行されたセッションは同格 |
| tenant/organization概念 | データモデルに存在しない。`schema.sql`の全44テーブルに`tenant_id`/`organization_id`列は皆無 |
| 所有権 | `oauth_clients.source_id`(書込み先ソース)が最も近い概念だが、これは「クライアントがどのデータソースに書けるか」であり「誰が所有するか」という人格的所有権ではない |
| データ分離 | `source_id`(書込み)+`federated_read`(読み込み許可ソース配列)による、ソース単位の緩やかな分離のみ。Postgresエンジンの場合は`multi-tenant safety`という言及が`db-lock.ts:779,909`にあるが、これは**DB接続プーラーのロックID衝突回避という接続レベルの話**であり、アプリケーションレベルのテナント分離ではない |
| 権限境界 | スコープ(6値)がクライアント単位で設定される以外に、組織単位・チーム単位の境界は存在しない |

**判定**: FAIL寄り。現状は明確に単一ユーザー/単一組織を前提とした設計であり、`source_id`によるデータソース単位の緩い分離が、マルチテナント化の際の最も近い足がかりになります。

---

## 8. 委任

| 委任パターン | 対応状況 | 根拠 |
|---|---|---|
| 親エージェントからサブエージェント | **実装あり**。`submit_agent`オペレーション(`operations.ts:3038-3192`)。呼び出し元OAuthクライアントの`bound_tools`/`bound_slug_prefixes`のサブセットのみを子ジョブに許可(`operations.ts:3100-3119`で実際に絞り込みを検証) | `operations.ts:3038-3192` |
| 人間からサービス | 専用の表現なし。人間は管理画面セッションのみ、サービスはOAuthクライアントのみで、両者を繋ぐ「委任」表現はない | - |
| サービスから一時ジョブ | `minion_jobs`が一時実行単位。`__owner_client_id`で呼び出し元を(非正規化フィールドとして)記録するが、正式なFKではない | `schema.sql:873-920`, `operations.ts:3160` |
| 長期資格情報から短期資格情報 | OAuthの`client_credentials`→`oauth_tokens`(TTL既定3600秒)がこれに相当。ただし「クライアントの長期資格情報→ジョブの短期資格情報」という二段目の委任チェーンは無く、ジョブ自体は独自のトークンを持たず`__owner_client_id`という参照のみで動作する | `schema.sql:673-681`(oauth_tokens.expires_at) |

**権限縮小(narrowing)は実際に機能するか**: **はい**。`submit_agent`のハンドラは要求された`allowed_tools`/`allowed_slug_prefixes`が呼び出し元の`bound_tools`/`bound_slug_prefixes`の部分集合であることを検証し、外れる場合は`permission_denied`を返します(`operations.ts:3100-3119`)。ただしこれは**1階層のみ**(クライアント→ジョブ)。**孫ジョブ生成は現状不可能であることが確認済み**(2026-08-01 Phase 9A補完監査): `submit_agent`は`parent_job_id`を一切設定せず常にトップレベルジョブを生成し、実行中のsubagent自身のツールレジストリ(`buildBrainTools`/`filterAllowedTools`)には`submit_agent`自体が含まれない。したがって権限継承・再narrowingのロジックが「未実装」なのではなく、孫委任を生成する手段自体が存在しない。詳細は`PHASE9A-SUPPLEMENTAL-AUDIT.md`§4。`parent_job_id`列自体は汎用ジョブキュー機構として存在するが、これは`self-fix.ts`(内部メンテナンス)や`gbrain agent run`(ローカルCLI専用のaggregatorパターン)でのみ使用され、OAuthで認可された委任経路とは無関係。

---

## 9. オフライン・失効・同期

| 項目 | 現状 |
|---|---|
| 有効期限 | `oauth_tokens.expires_at`(BIGINT、既定3600秒)。`oauth_codes.expires_at`(認可コード、短命)。管理画面`adminSessions`も`expiresAt`を持つ(`serve-http.ts:1370-1375`) |
| 失効 | `POST /admin/api/revoke-client`(`serve-http.ts:1810`付近、Phase8で実機テスト済み)。Phase8の実測結果(`TEST-RESULTS/lifecycle-test-run-20260730.json`)で、revoke後は既発行トークンも即座に401になることを確認済み — ソフトデリート(`deleted_at`)+アクティブトークン削除という直接的な実装 |
| 再接続 | 専用の「セッション再接続」プロトコルはない。トークン期限切れ後はクライアントが`client_credentials`または`refresh_token`で再度トークンを取得するのみ(標準OAuthフロー) |
| 競合 | データ層(PGLite/Postgres)のロック機構(`db-lock.ts`, `pglite-lock.ts`)はあるが、これは同時書き込みの競合制御であり、「同一主体の複数セッションが競合した場合」の主体レベルの競合解決ではない |
| キャッシュ済み権限 | `AuthInfo`はリクエストごとにDBから解決される(`clientName`のみリクエスト時にキャッシュしDB往復を避ける設計、`operations.ts:267-274`のコメント参照)。長期間キャッシュされた権限が失効後も有効であり続けるリスクは低いと考えられるが、リクエスト単位の検証タイミングの詳細(コネクションプーリング等)は本調査では未確認 |
| 部分接続 | オフラインファースト/部分同期という概念は見当たらず。gbrainは常時オンラインのサーバプロセス前提の設計 |

**判定**: 失効(revocation)は実装・実測ともに良好。オフライン耐性・部分接続・キャッシュ権限の期限切れ処理は、そもそも「常時オンラインのサーバ」という前提のため、この観点自体があまり設計されていません。

---

## Universal化10項目判定

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| 1 | 未知の新規クライアントが共通手順で登録・認証・利用できるか | **PASS** | `POST /admin/api/register-client`(`serve-http.ts`、Phase8で実機確認済み)は`name`/`scopes`/`grantTypes`/`tokenEndpointAuthMethod`のみを要求し、製品名を要求しない。Codex-CLI/Hermes-Agent/Claude-Webの3クライアントを同一手順で登録できたことをPhase8で実証済み |
| 2 | 新規クライアント追加時に知識コア・認可コア・データモデルを変更せずに済むか | **PASS** | `oauth_clients`への1行INSERTのみ。`operations.ts`/`scope.ts`にクライアント名を条件分岐として追加する必要はない。ただし`connect.ts`(利便ヘルパー)には新製品用の分岐追加が必要になる場合がある(コアではない) |
| 3 | 新プロトコル追加時に認証・認可・監査を再実装せずに済むか | **PARTIAL** | MCP/HTTPは`requireBearerAuth`共有で再実装不要。ただしCLIは独自に検証をバイパスする設計であり、「新プロトコル=常に再利用可能」とは言えない。**監査は経路ごとに個別実装されており、記録範囲が非対称であることを確認済み**(2026-08-01 Phase 9A補完監査): `/mcp`は成功・拒否・失敗を全て記録するが、`/ingest`は成功のみ記録し拒否・失敗は無記録、CLI・管理画面・GitHub Webhookは一切記録しない。詳細は`PHASE9A-SUPPLEMENTAL-AUDIT.md`§3 |
| 4 | 人間・AI・サービス・デバイスを共通主体モデルで扱えるか | **FAIL** | 統一された`Principal`型が存在しない(§1参照)。人間=管理画面セッション、AI/サービス=OAuthクライアントで表現方法が完全に別建て |
| 5 | クライアント・主体・セッション・資格情報・実行インスタンス・委任先を区別できるか | **FAIL** | `AuthInfo`(`operations.ts:264-308`)はクライアントIDとスコープのみを表現し、セッション・実行インスタンスという概念自体が存在しない |
| 6 | 未知の主体をポリシーに基づき安全に扱えるか | **PARTIAL** | 未登録クライアントは単純に401(拒否)。「未知だが条件付きで許可する」ようなポリシーベースの動的判断は存在しない(全面拒否/全面許可の中間がない) |
| 7 | 特定AIベンダー消滅後も中核設計が維持されるか | **PASS** | 認証・認可コアはベンダー名に依存していない(§6参照)。ベンダーが消滅しても、そのベンダー向けの`connect.ts`分岐が不要になるだけ |
| 8 | MCP廃止後も知識層の中核機能が維持されるか | **PASS** | Operationレジストリ(`operations.ts`)は知識操作の抽象化層として独立しており、`/ingest`という非MCPのHTTPパスも同じレジストリを呼ぶ。MCPが消えてもOperation自体とHTTP経路は存続可能な構造 |
| 9 | ローカル・クラウド・エッジ・オフライン・複数組織へ信頼境界を明示して展開できるか | **FAIL** | PGLiteは「single-tenant by design」と明記。組織・テナント概念がデータモデルに存在せず(§7参照)、オフライン/部分接続の設計もない(§9参照) |
| 10 | 将来の拡張点が明示され、認可迂回経路になっていないか | **PARTIAL** | `bound_*`列やスコープ拡張は将来の拡張点として機能する設計だが、CLIの検証バイパス(`oauth-provider.ts:133`のコメントで明示)は「意図された例外」であって「文書化された拡張点」ではない。迂回可能性としては認識されているが、体系的な拡張点一覧は存在しない |

**集計**: PASS 4(項目1,2,7,8) / PARTIAL 3(項目3,6,10) / FAIL 3(項目4,5,9) = 合計10(重複判定なし、追加項目なし、10項目全て判定済み)

> **訂正(2026-07-31)**: 初版では本行を「PASS 4 / PARTIAL 4 / FAIL 3」(合計11)と誤記していました。表本体(項目1〜10)は当初から重複・追加項目なく正しく10行でしたが、本集計サマリー文のみでPARTIALの計数を3ではなく4と書き誤り、完了報告にもこの誤記がそのまま転記されていました。上記が訂正後の正しい集計です。

---

## 根拠となる実ファイル一覧

- `src/core/types.ts`(1671行) — 知識コンテンツドメイン型。主体系の型なし
- `src/core/oauth-provider.ts`(1100行) — OAuth 2.1実装、`AgentClientBindings`型
- `src/core/scope.ts`(193行) — スコープ階層のSingle Source of Truth
- `src/core/operations.ts`(抜粋: 264-308行`AuthInfo`、3038-3192行`submit_agent`) — Operationレジストリ、認可判定`hasScope`呼び出し箇所
- `src/commands/serve-http.ts`(抜粋: 1364-1391行`requireAdmin`、1393-1410行`/admin/api/agents`、1810行`revoke-client`、1911-1916行`/mcp`,`/mcp-v2`、2257-2259行`/ingest`) — HTTPルーティング、3系統の認証機構
- `src/commands/auth.ts`(606行) — CLI登録コマンド
- `src/commands/connect.ts`(抜粋: 50-67行`AgentId`/`AGENT_SPECS`) — クライアント側設定ヘルパー、唯一のベンダー名分岐箇所
- `src/schema.sql`(1443行、抜粋: 612-701行 認証関連テーブル群、873-1077行 委任/ジョブ関連テーブル群) — DBスキーマ全体
- `src/core/migrate.ts`(抜粋: 911,1688,2126行) — single-tenant明記箇所
- `src/core/db-lock.ts`(抜粋: 779,909,923行) — multi-tenant safety(接続レベル)の言及
- `src/core/enrichment/budget.ts`(抜粋: 33行) — multi-tenant teams partition(コスト管理用、組織概念ではない)
