# Phase 9C — Audit Event ドメインモデル(`audit_events` テーブル設計)

**日付**: 2026-08-02
**位置づけ**: Phase 9C(Universal Audit Event Integration)の中核成果物である `audit_events` テーブルのドメインモデルを定義する。Stage 1(現状調査、6エージェント並列)の確認済み事実と、Stage 2(Opus設計)で確定した設計判断のみを整理・体系化したものであり、本文書は新たな設計判断を行わない。範囲は「コア列設計・未帰属状態モデル・機密情報保護方針」に特化する。監査対象経路の選定(scope boundary)・失敗時ポリシー・マイグレーション手順・テスト戦略等、同じStage 2設計内の他領域は、本文書の列設計の根拠として必要な範囲でのみ言及する。

---

## 0. 前提: 2026-08-02付でユーザーが確定した事項

Stage 2設計が `open_questions_for_user` として提起した4件は、いずれも同日付でユーザーが以下のとおり確定した。本文書は以下を確定済みの前提として扱う。

| # | 論点 | 確定内容 |
|---|------|---------|
| (a) | Phase 9B実装34ファイルの扱い | 独立コミット済み(commit `fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。Phase 9Cはこのコミットの上に積み重ねる。 |
| (b) | `oauth_clients` の hard delete → soft delete 統一 | 今回は実施しない(Opus提案どおり)。`src/commands/auth.ts:315` の hard delete 経路は現状維持し、`audit_events.client_id` はFKなしの非正規化列のままとする(§1・§2参照)。soft delete統一自体は別タスクとして記録済み扱い。 |
| (c) | `/admin/api/*` の読み取り専用GET 11ルート | 監査対象外のまま(Opus提案どおり)。Authority状態を変えないため対象外という scope_boundary の判断を維持する。 |
| (d) | `gbrain audit prune` の既定動作 | 自動削除なし(Opus提案どおり)。既定で保持期間を設けない(§4参照)。 |

---

## 1. `audit_events` コア列と Adapter JSONB の分離方針

### 1-1. 分離の原則

コア列の**列名**は製品名・AI名・ベンダー名・プロトコル名を一切持ち込まない。ただし `channel_id` 等のopen-world登録表の**値**は、運用者が経路を識別できるよう抽象化されたプロトコルカテゴリ名(`mcp_http`/`oauth_endpoint` 等)を用いてよい——これは個別の製品名・ベンダー名(Claude/ChatGPT/Anthropic等)とは異なり、認可判定に一切参照されない属性としての運用上の識別ラベルである。製品名・ベンダー名そのもの(Claude/ChatGPT等)は依然としてadapterの外へ一切現れてはならない。プロトコル固有情報のうちHTTPメソッド・パス・ステータス、JSON-RPCメソッド名、webhookイベント種別、User-Agent、マスク済みリモートアドレス、どのgbrainコンポーネントが書いたか等の**詳細**は、すべて `adapter JSONB NOT NULL DEFAULT '{}'` 列に閉じ込める。

`params_summary JSONB` は現行 `mcp_request_log.params` の直接後継であり、既存の `summarizeMcpParams()` による許可リスト方式(宣言済みキー名のみ記録、値は記録しない、`unknown_key_count`・`approx_bytes` のみ付加)をそのまま踏襲する。この既定 redaction は既に健全な設計であり、Phase 9Cで変更しない。

### 1-2. コア列一覧

| 列名 | 型 | NULL可否 | 意味 | 採用理由 |
|------|----|----------|------|----------|
| `id` | UUID | PK, NOT NULL(既定 `gen_random_uuid()`) | イベント行の一意識別子 | SERIALではなくUUID。書き込み時点でクライアント側生成できることが durable spill と再送時の冪等(`ON CONFLICT DO NOTHING`)の前提になる。SERIALでは spill 済み行の同一性が表現できない。 |
| `envelope_version` | SMALLINT | NOT NULL, 既定 1 | `params_summary`/`adapter` のJSONB形状バージョン | 将来これらのJSONB形状が変わったとき、過去行を誤解釈しないための唯一の安全弁。1列2バイトで得られる保険としては安い。 |
| `occurred_at` | TIMESTAMPTZ | NOT NULL | 事象が実際に起きた時刻(発行プロセスの時計) | durable queue/spill replayがあるため `recorded_at` と実際に乖離する。乖離を測れないと「監査の遅延」と「監査の欠落」を区別できない。 |
| `recorded_at` | TIMESTAMPTZ | NOT NULL, 既定 `now()` | DBが行を受理した時刻 | `occurred_at` との対比のため両方採用。 |
| `event_kind` | TEXT | NOT NULL, `REFERENCES audit_event_kinds(id)` | イベント種別(open-world登録表参照) | Phase 9Bの `principal_kinds` パターンの踏襲。新プロトコル・新イベント種別の追加がスキーマ変更を要さない(AUTHZ-INV-015)。 |
| `channel_id` | TEXT | NOT NULL, `REFERENCES audit_channels(id)` | 主体がどの経路から到達したか(transportとsource_kindを1つに統合) | `source_kind` という名はgbrain既存のpages provenance語彙(`capture-cli`/`mcp:put_page`)と衝突するため意図的に採用しない。`audit_channels` には `mcp_http`(Remote MCP JSON-RPC endpoint、HTTP限定)・`local_process`(`ctx.remote === false` のローカル呼び出し限定)に加え、新たに**`mcp_stdio`**(MCP over stdio: ローカルパイプ経由だが `ctx.remote === true` として扱われる呼び出し。per-token認証という概念自体が存在しない第三の経路)を追加登録する。`submit_agent`(stdio経路)の委任イベント記録(AUTHZ-INV-009)はこの `mcp_stdio` に帰属し、`mcp_http`・`local_process` のいずれにも該当しない(§3状態9も参照)。 |
| `attribution_state` | TEXT | NOT NULL, `REFERENCES audit_attribution_states(id)` | 未帰属状態モデルの中核(§3参照) | `principal_id = NULL` だけでは11通りの状態が区別できないため。 |
| `principal_id` | UUID | NULL, `REFERENCES principals(id) ON DELETE RESTRICT` | 帰属先Principal | `attribution_state = 'principal_attributed'` の場合にのみ値が入る。CHECK制約で強制(§3)。 |
| `client_id` | TEXT | NULL(FKなし) | 提示された時点のClient識別子 | FKを張らない理由: `src/commands/auth.ts:315` に `oauth_clients` の hard delete 経路が実在し(soft delete列 `deleted_at` はあるが未統一、§0(b))、RESTRICTを張ると監査行が1件でもあれば既存のclient削除コマンドが壊れる。よって「提示された時点の識別子」を保持する非正規化列とする。 |
| `actor_label` | TEXT | NULL | 人間可読な識別子 | 現行 `token_name`/`agent_name` の後継。Clientレコードが存在しない経路(レガシー、admin平面)でも人間が読める識別子を残すため。 |
| `credential_ref` | TEXT | NULL | 資格情報への参照(ハッシュ先頭16文字) | 既にDBに at rest で存在する `token_hash` の先頭16文字を使う。新たな暗号処理を導入せず、「どの資格情報が失効させられたか」を `access_tokens`/`oauth_tokens` と join可能にするためだけに使う(§5)。 |
| `operation` | TEXT | NOT NULL | 要求された操作名 | FKにしない。コード定義でリリースごとに増減するため。 |
| `required_scope` | TEXT | NULL | 判定に必要だったスコープ | 拒否理由を行だけで自己説明可能にする。 |
| `scopes_snapshot` | TEXT[] | NULL | 判定時点の実効スコープ | Clientのscopeは後から変更されるため事後再構成が構造的に不可能で、これを取らないと「どの権限で行ったか」に永久に答えられない。**認可では絶対に読まない**(§6・テストで強制)。 |
| `decision` | TEXT | NOT NULL, 既定 `'not_applicable'`, CHECK `IN ('allowed','denied','not_applicable')` | 認可判定の結果 | 現行 `mcp_request_log` は `status='success'\|'error'` で「許可/拒否」と「成功/失敗」を混同している。許可/拒否/失敗/成功の一貫追跡というユーザー要求に応えるため2軸に分離する。 |
| `outcome` | TEXT | NOT NULL, CHECK `IN ('succeeded','failed','rejected','pending')` | 実行結果 | 同上。`decision`/`outcome` は「モデル自身の語彙(判定結果の種類)=閉集合」のためCHECK制約とし、登録表にはしない(登録表は「世界の語彙(プロトコル・主体種別・イベント種別)=開集合」に限定)。 |
| `reason_code` | TEXT | NULL | 拒否・失敗理由の機械可読コード | `insufficient_scope`/`unknown_operation`/`invalid_signature`/`client_revoked` 等。FKにしない(コードとともに増える)。 |
| `resource_kind` | TEXT | NULL | 作用対象の種別(polymorphic) | `('page', slug)`、`('oauth_client', client_id)`、`('access_token', name)`、`('source', source_id)` 等。FKなし(対象は正当に削除される)。 |
| `resource_ref` | TEXT | NULL | 作用対象の識別子 | 同上。 |
| `source_id` | TEXT | NULL | gbrain実在のデータ境界への帰属先 | webhook/ingestの帰属先であり、将来Organization/Tenant境界フィルタの前身になる。FKなし(sourcesは `sources_remove` でhard deleteされる)。 |
| `job_id` | INTEGER | NULL(FKなし) | 関連ジョブID | `src/core/minions/queue.ts:385/926/1060` で `minion_jobs` 行が物理DELETEされ `remove_on_complete` も存在する。RESTRICTはキューを壊し、CASCADEは監査履歴を破壊するため、どちらも採らずFKなしとする。 |
| `correlation_id` | TEXT | NOT NULL | 1インバウンド要求で発生する複数イベントを束ねるID | — |
| `parent_event_id` | UUID | NULL(自己FKなし) | 委任チェーンの親イベント | AUTHZ-INV-009(委任チェーン再構成)の直接的手段(`submit_agent`イベント→ジョブ実行イベント)。自己FKを張らない理由: 長時間ジョブの子イベントが親より後まで残り、retention pruneの順序に依存した失敗が起きうるため。「purgeできない」でも「INSERTできない」でもなく「親がpurge済みであることが分かる」形で劣化させる。 |
| `latency_ms` | INTEGER | NULL | 処理時間(ms) | 既存 `/admin/api/requests` 消費者の維持。 |
| `error_message` | TEXT | NULL | エラーメッセージ | redaction + 2000字truncate(§5)。 |
| `params_summary` | JSONB | NULL | 現 `mcp_request_log.params` の直接後継 | `summarizeMcpParams()` の許可リスト方式をそのまま踏襲(§1-1)。 |
| `adapter` | JSONB | NOT NULL, 既定 `'{}'` | プロトコル固有情報の唯一の置き場 | §1-1参照。 |

`outcome` 列の `'pending'` について: Phase 9Cが対象とする全 `event_kind` において、`outcome='pending'` は実際には書き込まれない(将来の非同期・長時間実行イベント向けに予約された値であり、Phase 9Cのスコープでは未使用)。CHECK制約に含めるのは将来の拡張点として型を安定させるためであり、Phase 9Cの実装が実際にこの値を書き込むことはない。

FKに関する原則と例外(`client_id`・`job_id`・`parent_event_id` の3件)は Phase 9B が確立した「FKは原則 `ON DELETE RESTRICT`」という方針に対する明示的例外であり、いずれも「既存の正当な削除操作を壊さない」という単一基準に基づく。`principal_id → principals(id) ON DELETE RESTRICT` は原則どおりで、Phase 9Bの `oauth_clients.principal_id` と整合する。

### 1-3. 分類3列は open-world 登録表、判定結果2列は CHECK

- 登録表(`audit_event_kinds`・`audit_channels`・`audit_attribution_states`)は Phase 9B の `principal_kinds` パターンを踏襲し、新規行の `INSERT` のみでスキーマ変更なしに拡張できる。
- `decision`・`outcome` は登録表にせずCHECK制約に留める。判定基準: **モデル自身の語彙(判定結果の種類)は閉集合=CHECK、世界の語彙(プロトコル・主体種別・イベント種別)は開集合=登録表**。

---

## 2. 見送った候補とその理由

| 候補 | 内容 | 見送りの理由 |
|------|------|--------------|
| `delegation_id` | 委任(Delegation)を表す独立列・専用テーブル | Delegationテーブルの新設自体がPhase 9Eの対象(non-goal)。1階層の委任チェーンは `event_kind='delegation.grant'` + `parent_event_id` + `job_id` で完全に再構成でき、AUTHZ-INV-009を満たす。実体のない概念への先行FK列は追加しない。 |
| `organization_id` | Organization/Tenant境界を表す列 | Phase 9G。org は `principal_id` からのjoinで導出でき、破壊的backfillなしに後付けできる。`ALTER TABLE ADD COLUMN` 1本の拡張点として設計文書に記載するのみに留める。Phase 9Cを9Gより先行させる根拠は「principal_idを書き込み時点で確実に取得しておけば、9G到来時に過去の監査行のorg帰属はクエリ時joinで復元できる(回復不能な情報損失が発生しない)」という点にある。 |
| `execution_instance_id` | 実行インスタンスを表す独立列 | 独立列にしない。1つのインバウンド要求から複数の `audit_events` 行(例: `authorization.decision` 行 + `operation.request` 行)が生成されうる設計であるため、Execution Instance(1回のリクエスト試行)を表す識別子は `audit_events.id`(1行ごとに一意)ではなく `correlation_id` である。`job_id` は1ジョブ(委任実行)の識別子として別途機能する。したがってExecution Instance識別子の役割は既存の `correlation_id`/`job_id` が担っており(PHASE9A-TARGET-DOMAIN-MODEL §5が「新規テーブル不要」と確定済み)、新たな独立列を追加する必要はない。 |
| integrity情報(hash chain / 署名) | 改ざん耐性のための暗号学的連鎖・署名 | 見送り(non-goal)。gbrainはserver・worker・CLIの複数プロセスが同一表へ並行書き込みするため、hash chainには直列化writerが必要でアーキテクチャ変更を伴う。かつDBへ書ける主体であればchain自体を再計算できるため、同一信頼境界内では改ざん耐性を実質的に提供しない。現実の完全性境界はPostgresのロール権限とRLSであり、そこを固めるほうが正しい。 |
| `emitter` の独立列化 | どのgbrainコンポーネントが書き込んだかを表す列 | 独立列にせず `adapter.emitter` に格納する。`channel`(主体がどう到達したか)と `emitter`(どのgbrainコンポーネントが書いたか)は別概念だが、後者はクエリ主軸にならないため列を割かない。 |

---

## 3. 未帰属状態モデル(11状態)

`principal_id = NULL` は下表の状態2〜11すべてで真になる。したがって `principal_id` 単独では「なぜ帰属していないのか」に一切答えられない。この問いに答えるのが `attribution_state`(NOT NULL、登録表 `audit_attribution_states` へのFK)である。

| # | 状態名(id) | 意味 | `principal_id` の値 | どの経路で発生するか |
|---|-----------|------|---------------------|----------------------|
| 1 | `principal_attributed` | Client検証済みかつ `oauth_clients.principal_id` が設定済み | 値が入る(11状態中、値が入る唯一の状態) | OAuthパス(`oauth-provider.ts`)で、Clientに人手でPrincipalが紐付け済みのケース |
| 2 | `client_only` | Clientは検証済みだが `oauth_clients.principal_id IS NULL` | NULL | OAuthパスでPrincipal未紐付け。Phase 9Bが正当な既定と定めた状態(AUTHZ-INV-004/012)。「不明」ではなく「未紐付け」。 |
| 3 | `legacy_credential` | `access_tokens` レガシー経路での認証。Client/Principalと別のID空間であり、この資格情報方式では帰属が**構造的に取得不可能** | NULL | `oauth-provider.ts` のレガシー `access_tokens` パス((b)経路)。`scopes: ['read','write','admin']` を無条件付与する最も強い権限の経路が、最も帰属不可能という組み合わせ。2と絶対に畳み込まない。 |
| 4 | `admin_session` | 管理画面のbootstrap-token保持者。`client_id`/`principal_id` という概念自体がその平面に存在しない | NULL | `/admin/login`、`requireAdmin` 配下の `adminSessions`(インメモリMap)。 |
| 5 | `message_authenticated` | 主体認証を伴わないメッセージ真正性検証のみ | NULL | GitHub Webhook HMAC検証(`POST /webhooks/github`)。帰属先は `source_id` であって Principal ではない。AUTHZ-INV-010がPolicy Decision対象外と明記した種類の主体。 |
| 6 | `unauthenticated` | 資格情報が一切提示されずにハンドラへ到達(pre-auth拒否) | NULL | 未認証リクエスト全般。 |
| 7 | `authentication_failed` | 資格情報は提示されたが棄却(署名不一致、失効済み、期限切れ) | NULL | トークン検証失敗・HMAC不一致等。6(不在)とは意図的に分離。「不在」と「主張の失敗」はセキュリティ上の意味が異なる。 |
| 8 | `system_internal` | 外部主体なしにgbrain自身が発行 | NULL | スケジュールされたworker、self-fix、retention job等。 |
| 9 | `local_process` | `ctx.remote === false` のローカル呼び出し | NULL | ローカルCLI呼び出し。OS境界が認可モデルでありgbrain層の主体が存在しない。**Phase 9Cでは計装しないが値はシードする**(将来の計装がスキーマ変更ではなくデータ行追加で済むように)。**MCP over stdio(`ctx.remote === true` だが資格情報という概念自体が存在しない経路)はこの状態には含めない**: stdioの `channel_id` は新設の `mcp_stdio`(§1-2)を用いる。stdio経由 `submit_agent` の拒否(`permission_denied`、AUTHZ-INV-009)は、資格情報が一切提示されない点で状態6 `unauthenticated` と意味的に適合するため、既存の `attribution_state='unauthenticated'` をそのまま用いる(新規の `attribution_state` は追加しない)。 |
| 10 | `unmigrated_legacy_record` | Phase 9C以前のストレージ由来で帰属が構造的に復元不能な記録 | 該当なし(**`audit_events` には決して書き込まれない**) | 互換ビュー `audit_events_compat` が `mcp_request_log` のレガシー行へ射影するためだけに使う定数。1行もUPDATEしない「射影」であり「backfill」ではない。 |
| 11 | `attribution_unavailable` | 帰属を持つべき経路なのに書き込み時点で欠落していた。**正常状態ではなく欠陥シグナル** | NULL | 未登録の `attribution_state` IDがWriterへ渡された場合の正規化先(`reason_code='unregistered_attribution_state'`)等。`doctor` はこの件数が非ゼロなら警告する。 |

### 3-1. CHECK制約による強制メカニズム

- `attribution_state` は **NOT NULL、既定値なし**。Adapter(書き込み元)は必ず明示的に指定する。既定値を持たせると新規Adapterが無言で誤ったバケツに落ちるため。
- DB レベルのNULL潰し禁止:

```sql
CONSTRAINT chk_audit_attribution
  CHECK ((attribution_state = 'principal_attributed') = (principal_id IS NOT NULL))
```

  「帰属済みと言いながら `principal_id` が空」「`principal_id` があるのに帰属済みでない」の双方をDBレベルで拒否する。違反は `23514` としてプログラミングエラーの形で即座に露見する。
- **未知Adapterへの対処**: 登録表はopen-worldのため新状態は `INSERT` 1行で追加できる。ただし未登録IDが渡された場合、WriterはFK違反で書き込みを失う前に `attribution_unavailable` + `reason_code='unregistered_attribution_state'` へ正規化し**必ず1行残す**。監査が消えるより誤分類が残るほうがましであり、11番は欠陥シグナルなので `doctor` が検知する。
- `attribution_state` は認可コードから一切読まれない(AUTHZ-INV-001)。`scope.ts`/`operations.ts` の認可判定部に `audit_events`・`attribution_state`・`principal_id`・`channel_id` のいずれの参照も現れないことを、grepベースのテストで機械的に強制する(§6)。

---

## 4. append-only 不変性

- `audit_events` は **append-only** とする。`UPDATE`/`DELETE` は retention prune のみに限定する。
- ジョブの終了状態など、時間経過に伴う状態変化は既存行の更新ではなく、`parent_event_id` で連なる**新しい行**として記録する。「既存監査情報を壊して置換しない」という設計姿勢の構造的担保である。
- **`mcp_request_log` は物理的に一切変更しない**(列追加なし、FK追加なし、rename なし、DROP なし)。Phase 9C以降は新規書き込みを行わない凍結レガシー表になり、既存履歴行は読み取り専用のままそのまま保持される。
- `audit_events` への **backfill は行わない(ゼロ行)**。`mcp_request_log` の既存行から `audit_events` 行を合成しない。帰属は書き込み時点で `AuthInfo.principalId` を直接INSERTへ渡すことで取得し、事後の文字列一致等による推測backfillは一切行わない(誤帰属は欠落より監査上有害という判断)。互換ビュー `audit_events_compat` がレガシー行へ `attribution_state = 'unmigrated_legacy_record'` を射影するのは**射影であってbackfillではない**(1行もUPDATEしない)。
- **保持期間**: `gbrain audit prune --older-than <days> [--dry-run]` を提供するが、**既定では自動削除しない**(§0(d)、確定済み)。監査記録の無言削除は増加より有害という判断による。`doctor` は `audit_events`/`mcp_request_log` の行数・サイズが閾値を超えたら警告するが、削除は強制しない。
- `mcp_request_log` の物理DROPおよび互換ビューの撤去(退役)はPhase 9Cのnon-goalであり、凍結表を残す期間中は新規書き込みが来ないため無制限増加自体は停止する。

---

## 5. 機密情報保護

### 5-1. 保存禁止対象(コア列・Adapter JSONBのいずれにも一切保存しない)

- アクセストークン本体 / リフレッシュトークン本体 / authorization code本体 / `code_verifier` / `code_challenge` 全体
- `client_secret`
- Cookie・`Set-Cookie`
- `Authorization` ヘッダ
- bootstrap token / magic-link token
- `webhook_secret` / HMAC署名値
- パスワード(ただし`error_message`に限り、URLのuserinfo部分に埋め込まれた形式・既知の構文パターン(§5-2参照)に一致する形式のみ機械的に除去できる。いずれにも一致しない任意形式のフリーテキストパスワードは、構文的パターンマッチでは原理的に検出不可能な既知の残存限界として§5-2で明示的に開示する)
- DB接続文字列(URL形式のものはURL redactorで対処、§5-2参照)

これらは、上記の既知の構文的限界を除き、`params_summary`・`adapter`・`error_message`・`resource_ref` のいずれにも入らない。Writer内の**単一のredaction関数**を全経路が通る構造にし、経路ごとの実装差を作らない。

本節(§5-1)が列挙する保存禁止対象は、`--log-full-params` の状態(ON/OFF)に関わらず常に適用される最低限の保護であり、このフラグによって免除されることはない。フラグが制御するのは、`summarizeMcpParams()` による許可リスト方式(既定)か、宣言済みキー名以外も含む生paramsをそのまま記録するか、という「記録の粒度」の選択のみである。フラグON時であっても、Writer内の単一redaction関数(§5-2のURL redactor・パターン除去を含む)は依然として全ての値に適用され、userinfoを含むURL・トークン・シークレットの類が平文で `audit_events` へ書き込まれることはない。

### 5-2. Redaction方式

- **`params_summary`**: `summarizeMcpParams()` の許可リスト方式(宣言済みキー名のみ、値は記録しない、`unknown_key_count`・`approx_bytes` のみ)をそのまま踏襲する。既に健全であり変更しない(§1-1)。
- **`--log-full-params`**: 適用範囲を **MCPツール引数に限定**する。Phase 9Cが新設するOAuth/admin/webhook/ingest/delegationイベントには**適用されない**(このフラグでauthorization codeやclient_secretが生ログ化される経路を絶対に作らない)。既定無効・起動時警告は現状維持。フラグの適用範囲拡大は明示的に禁止事項とする。フラグはあくまで「記録の粒度」(許可リスト方式か、宣言外キーを含む生paramsをそのまま記録するか)を切り替えるのみであり、ON時であっても§5-1の保存禁止対象と単一redaction関数の適用は免除されない(上記参照)。
- **URLの扱い**(`sources_add` の資格情報埋め込みURLリスク対策): 監査にURLを残す場合は必ずURL redactorを通す。(a) userinfo(`user:pass@`)を除去、(b) クエリ文字列を**全削除**、(c) `url_host` と `url_path_prefix`(先頭1セグメントのみ)を `adapter` に格納。これにより「どのホストへ接続しようとしたか」という監査価値を保ちつつ、資格情報埋め込みURLの保存経路を構文的に閉じる。このURL redactorは `--log-full-params` の状態に関わらず常に適用される(上記参照)。
- **`error_message` のredaction**(現状は専用redactionなし=Phase 9Cで新設): (1) `scripts/release/lib.sh` の `scan_for_secrets()` が定義する既存パターンセット(下記(2)参照)と同等のパターンを、Writer側でTypeScriptネイティブな正規表現マッチとして実装し適用する(`scan_for_secrets` 自体はリリースパイプライン専用のbashゲート関数であり実行時Writerから直接呼び出すことはできないため、パターンセットのみを踏襲し、値変換関数として独立に実装する)。(2) パターン除去: Bearerトークン、JWT形状(3セグメントのbase64url)、`sk-`/`ghp_`/`AKIA`/`gbrain_cs_`/`gbrain_code_` 前置、PEM秘密鍵ヘッダ(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)、32文字以上の連続hex。(3) 2000文字でtruncateし `…[truncated N chars]` を付す。
- **`error_message` へのURL redactor適用(汎用化)**: `postgres://`・`mysql://`・`redis://` 等のスキームを含むURL形式の文字列についても、上記(URLの扱い)で定義済みのURL redactor(userinfo除去)を `error_message` 内のURL様部分文字列に適用する。スキーム`://`で始まりuserinfo(`user:pass@`)を含むパターンを検出し、host以降のみを残す(例: `postgresql://user:MyPass1@host/db` → userinfo部分を除去したhost以降のみ保持)。
- **既知の残存限界(構文的に検出不能なフリーテキスト秘密情報)**: 上記のURL redactorおよび既存5パターン(Bearerトークン・JWT形状・`sk-`/`ghp_`/`AKIA`/`gbrain_cs_`/`gbrain_code_`前置・PEM秘密鍵ヘッダ・32文字以上の連続hex)のいずれにも一致しない任意形式のフリーテキストパスワード(例: 環境変数由来のエラーメッセージに埋め込まれた生パスワード文字列)は、構文的パターンマッチでは原理的に検出不可能な残存リスクである。参照元の `scripts/release/lib.sh` の `scan_for_secrets()` 自体も同じ限界を持つことを確認済み。これはPhase 9Cのスコープでは緩和しきれない既知の限界として正直に開示する(隠蔽しない)。緩和策として、エラーメッセージを生成する側のコード(呼び出し元)が可能な限り構造化エラー(secret値を含まない定型メッセージ)を返すよう努めることを将来の改善方向として付記する(Phase 9Cの実装スコープには含めない)。

本節(§5)が定める機密情報保護は、監査記録(audit_events/spill)への永続化に適用されるものであり、SSE配信(`--log-full-params`有効時のデバッグ用リアルタイム配信、serve-http.ts:300-309/448-452)には適用されない。SSE配信自体のredaction化はPhase 9Cのスコープ外とする——これは監査記録の新設とは独立した既存機能(事前警告付きの明示的なopt-inフラグ)の問題であり、資格情報埋め込みURL等がSSEへ流れうるという既存リスクが残ることは発見事項として記録し、別途bdタスクとして登録する。

### 5-3. サイズ上限(Writer側で強制、DB制約にはしない)

- `params_summary`/`adapter`: 各4KB(JSONBシリアライズ後)。超過時は `{"redacted":true,"reason":"oversize","approx_bytes":N}` に置換。
- `error_message` 2000字、`operation` 128字、`resource_ref` 512字、`actor_label` 256字、`reason_code` 64字。
- DBのCHECK制約にしない理由: 制約違反はクラス1(Authority状態変更)でfail-closedを誘発し、長い値が来ただけで正当な操作が503になりうるため。Writer側truncate + 単体テストで担保する。

### 5-4. `credential_ref` のハッシュ参照方式

- `credential_ref` には**既にDBに at rest で保存されている `token_hash` の先頭16文字**を使う。新たな暗号処理を導入しない。
- これにより「どの資格情報が失効させられたか」を `access_tokens`/`oauth_tokens` とjoin可能にする。
- 秘密そのものではなく、既存の保存済みハッシュの部分列であるため新規の開示にはならない。
- `client_id` は秘密ではないため全長を保存する(監査の主目的そのもの)。

### 5-5. PII方針

- `principals.display_name` は `audit_events` へ**コピーしない**(`principal_id` のみ保持)。PIIを1箇所に留めることで、将来の削除要求への対応が監査履歴の書き換えを要さなくなる。この一点のみで display_name 非複製が正当化される。
- IPアドレス: マスク済みのみ保存する(既存の `oauth-diagnostic.ts` の `maskRemoteAddress` 実装をコアへ移して再利用: IPv4は末尾オクテット0、IPv6は先頭2グループのみ)。生IPは保存しない。
- User-Agent: 200文字truncateで `adapter` に保存する(秘密ではなく、クライアント識別の監査価値があるため)。

### 5-6. RLS方針

- `audit_events` は作成時にRLSを有効化する(`mcp_request_log` と同水準。v37(`takes_and_synthesis_evidence`)と同形の実装パターン: `sql`フィールドに共通DDL+Postgres向けRLS有効化DOブロックを全文含め、`sqlFor.pglite`にはRLSブロックのみ除いた同一DDLを重複記述する。詳細は`PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md` §2-1/§2-3参照)。
- `dashboard-m1ja3`(`principals`/`principal_kinds` がv24 RLS静的リストに未登録)を**同時に解消**する。`audit_events` が `principals` へJOINする以上、ここを未設定のまま出荷すると監査データ経由でRLS未設定表が露出するため、Phase 9Cの実施範囲に含める。
- `mcp_spend_log`/`mcp_spend_reservations` のRLSはPhase 9C対象外(`audit_events` は参照しない)。non-goalとして明記する。

---

## 6. この文書が満たすべき不変条件

`audit_events` はPhase 9Bで確立されたAUTHZ-INV-001〜004を破らないことを前提として設計されている。以下に再掲する。

### AUTHZ-INV-001: Principal種別・Client種別・製品名・ベンダー名・プロトコル名だけでCapabilityを決定しない

「Humanだからadmin」「Agentだからagent scope」「既知製品だから信頼」「特定プロトコルだから信頼」のような、種別・名称のみに基づく権限分岐を禁止する。

### AUTHZ-INV-002: 権限は明示的に検証可能な情報源からのみ導出される

権限は、Credentialの検証結果・Client登録状態・Principalとの確認済み関連・明示的なCapability grant・対象Resource・Policy評価・Delegation・有効期限・失効状態・信頼境界・Organization/Tenant境界のいずれかからのみ導出する。自己申告のヘッダ値等を権限根拠にしない。

### AUTHZ-INV-003: 未検証の主体に暗黙の権限を与えない

Credentialの検証に成功していない主体、またはPrincipalが未確定(unknown)の主体に対して、明示的なCapability grantなしに何らかの権限を暗黙に付与しない。

### AUTHZ-INV-004: Unknownは全面許可・全面拒否の二択にしない

「Principal不明」は拒否理由にも許可理由にもならない。Clientのscopeに従って通常通り動作する有効な状態として扱う。

### 認可判定への不参照

`audit_events` の列(`principal_id`・`attribution_state`・`channel_id`・`scopes_snapshot` を含む)は、**いかなる形でも認可判定(`scope.ts`/`operations.ts` の `hasScope`/`authorizeOperation`)の入力にならない**。監査目的でPrincipal情報・帰属状態を「参照」することと、認可判断に「利用」することは明確に別物として扱う。

この不参照は、`scope.ts`/`operations.ts` の認可判定パスに `audit_events`・`attribution_state`・`principal_id`・`channel_id` のいずれの参照も現れないことを検証するgrepベースの静的テスト、および同一scopes・異なる `attribution_state`(`authorizeOperation()`経路に実際に到達しうる9状態)で同一操作を実行し認可結果が完全に一致することを確認するパラメタライズドテストの二重で、コードレベルで固定される。監査書き込みが失敗した状態でも認可結果が変わらないこと(fail-openが許可へ倒れないこと)も同様にテストで担保する。

grep対象は `scope.ts`/`operations.ts` に加え、`src/commands/serve-http.ts` 内の `requireAdmin` 関数本体(および同ファイル内でPhase 9Cが新設する監査計装コード)も含める。`requireAdmin` は `hasScope`/`authorizeOperation` を一切呼び出さない、`scope.ts`/`operations.ts` とは構造的に別の認可平面であるため、両方を独立に検証しなければ、admin平面へのPrincipal情報混入を検知できない。この構造的分離自体が、パラメタライズドテストの対象から外れる残り2状態(`admin_session`: `requireAdmin`配下でのみ発生し`authorizeOperation()`に到達しない。`unmigrated_legacy_record`: `audit_events`へは決して書き込まれない互換ビュー専用の射影定数であり、生きた操作実行に紐づく状態ではない)を担保する。
