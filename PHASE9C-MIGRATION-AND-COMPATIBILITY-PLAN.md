# Phase 9C — マイグレーション・互換性計画

**日付**: 2026-08-02
**対象**: `audit_events` 導入に伴うスキーマ移行(v126〜v128)・`mcp_request_log` の扱い・FK方針・PGLite/PostgreSQL両対応・Backfill方針・ロールバック・保持期間
**位置づけ**: 本書はPhase 9C(Universal Audit Event Integration)の設計文書のうち、マイグレーション・互換性計画パートを担当する。内容はStage1(現状調査、6エージェント並列)およびStage2(Opusによる正式設計)の結果に記録済みの決定事項を整理・体系化したものであり、本書独自の新規設計判断は行っていない。**実装は含まない。**

---

## 0. 前提: ユーザー確定事項(2026-08-02)

以下4件は、Stage2設計(`open_questions_for_user`)に対する回答としてユーザーが2026-08-02に確定した事項であり、本書はこれを前提として記述する。

| # | 事項 | 確定内容 |
|---|------|----------|
| (a) | Phase 9B実装の未コミット状態 | Phase 9B実装34ファイルは独立コミット済み(commit `fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。したがって本書が前提とする`LATEST_VERSION = 125`(`principal_identity_foundation`)は、作業ツリー上のみの状態ではなく、コミット済みのベースラインである。 |
| (b) | `oauth_clients`のhard delete→soft delete統一 | **今回は実施しない**(Opus提案どおり)。`src/commands/auth.ts:315`の`DELETE FROM oauth_clients WHERE client_id = ...`によるhard delete経路は現状のまま残り、`audit_events.client_id`はFKなしの非正規化列のままとする(詳細は§3例外1)。 |
| (c) | `/admin/api/*`読み取り専用GET 11ルートの監査対象化 | **監査対象外のまま**(Opus提案どおり)。Authority状態を変えない読み取り専用GETは`audit_events`書き込みの対象に含めない。 |
| (d) | `gbrain audit prune`の既定動作 | **既定は自動削除なし**(Opus提案どおり)。監査記録の無言削除は増加放置より有害と判断し、削除は運用者の明示操作(`--older-than`)を必須とする(詳細は§7)。 |

---

## 1. `mcp_request_log` の扱い

### 1-1. 検討した4案の比較

| # | 案 | 利点 | 欠点 | 採否 |
|---|----|------|------|------|
| 1 | 既存表を拡張(`ALTER TABLE mcp_request_log ADD COLUMN`で`principal_id`等を追加) | 差分最小、既存リーダーがそのまま使える | (a) `mcp_request_log`は「MCP経路の要求ログ」という名前と意味を持ち、`/token`・`/admin`・webhookをここへ混在させるのは意味論的に破綻する。(b) `id SERIAL`のためdurable spillの冪等再送(`ON CONFLICT DO NOTHING`)が実装できない。(c) `status`単一列に`decision`/`outcome`の2軸を押し込むと既存消費者を壊すか2軸分離を諦めるかの二択になる。(d) 既存のschema-verify自己修復パスがALTER TABLE ADD COLUMNでFK句を正規表現除去する既知欠陥(`dashboard-r3be4`)に、新規FK列がそのまま乗ってしまう。 | **不採用** |
| 2 | `mcp_request_log`をrenameし同名VIEWへ置換 | 読み取り面が完全に単一化される | 実コード読解で危険性を確認済み: `pglite-engine.ts:486` / `postgres-engine.ts:542`の`verifySchema`プローブは`information_schema.tables`を見るためVIEWでも存在ありと判定してしまい、その先の自己修復が`ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS agent_name TEXT`をVIEWに対して実行して失敗する。本番稼働中のブレインで起こりうる。 | **不採用** |
| 3 | envelope分離(コア表+プロトコル別サブ表) | 正規化として綺麗 | 1イベントにつき2 INSERTが必要になり、fail-closedクラスのトランザクション設計とspill形状が倍複雑化する。得られる正規化の価値は`adapter` JSONB列で十分代替できる。 | **不採用** |
| 4 | 新表`audit_events`＋互換ビュー＋段階移行 | 意味論的に正しい新表を作りつつ既存データを一切破壊しない。UUID主キーによりdurable spillの冪等再送が可能。互換ビューで読み取り面を単一化できる | 実装コストは4案中最大(新表・互換ビュー・書き込み経路移行の3点セットが必要) | **採用** |

### 1-2. 採用案の具体

- **`audit_events`を新規正本表として作成する**。
- **`mcp_request_log`は物理的に一切変更しない**(列追加なし、FK追加なし、rename なし、DROP なし)。Phase 9C以降は新規書き込みを行わない**凍結レガシー表**になり、既存の履歴行は読み取り専用のままそのまま保持される。この不変性は**スキーマ/DDLレベル**(ALTER/DROP/rename/列追加/索引追加の禁止)を指す。既存行への**行レベルDELETE**は、`gbrain audit prune`(既定無効・運用者の明示的オプトイン、§7)経由でのみ可能であり、これはスキーマ不変性とは別軸であるため矛盾しない(§1-3・§7の`gbrain audit prune`が`mcp_request_log`も削除対象とする記述と両立する)。
- **互換ビュー`audit_events_compat`を新設する**(§2-2)。`mcp_request_log`と同形の列(`id, token_name, agent_name, operation, latency_ms, status, params, error_message, created_at`)に`attribution_state`列を加え、レガシー行と新行を`UNION ALL`する。
  - `id`はSERIAL(整数)とUUIDで型が異なるため、ビュー上は`TEXT`へ射影する。
  - `status`は`(decision, outcome)`から写像する: `outcome='succeeded'` → `'success'`、それ以外 → `'error'`。これによりv0.26.3の永続化回帰テストの前提(`tools/list`+`tools/call`後に2行以上)が互換ビュー経由でも維持される。
  - レガシー行には`attribution_state`として定数`'unmigrated_legacy_record'`を射影する(1行もUPDATEしない=射影であってbackfillではない。§5-4参照)。
- **`/admin/api/requests`を含む既存リーダーを`audit_events_compat`へ向け替える**。読み取り面は1つのまま、書き込み面だけが新表へ移る。
  - 向け替え対象の既存リーダーは`/admin/api/requests`だけでなく、`mcp_request_log`を直接クエリする以下3エンドポイントも含む: `/admin/api/agents`(`last_used_at`/`total_requests`/`requests_today`のサブクエリ)、`/admin/api/stats`(`requests_today`の`count(*)`)、`/admin/api/health-indicators`(`status!='success'`件数による`error_rate`計算)。いずれも`audit_events_compat`(`channel_id IN ('mcp_http', 'ingest_http')`限定)を参照するよう向け替える。カットオーバー後もこれら3エンドポイントが引き続き正しい値(`/ingest`失敗を含む、より正確な値。§2-2で述べる意図的な挙動変化を参照)を返すことをStage6で検証する。
- **恒久的な二重書き込みは行わない**。カットオーバー後、`mcp_request_log`へのINSERTは0件になる(ただし`src/mcp/http-transport.ts`の独自INSERT経路(dead code、本番到達不能、`PHASE9C-CURRENT-AUDIT-PATHS.md`参照)は本設計の対象外とする。このファイルは`gbrain serve --http`経由の本番コードパスからは到達不能であり、テストファイル経由でのみ実行される。将来この経路が再有効化される場合は、別途Phase 9C相当の監査計装の要否を検討する必要がある)。

### 1-3. 段階と退役

- Phase 9C: `audit_events`作成 → 書き込み移行 → 互換ビュー提供 → リーダー向け替え。
- **`mcp_request_log`の物理DROPおよび互換ビューの撤去(退役)はPhase 9Cのnon-goal**。凍結表を残す期間中も、新規書き込みが来ないため無制限増加は停止する。既存行の削除手段は`gbrain audit prune`が両表を対象に提供するが、既定は無効(§0(d)・§7)。

### 1-4. 併せて解消する既存欠陥

- 7箇所の`catch { /* best effort */ }`によるsilent-swallowの全廃。
- インデックス2本のみ(`idx_mcp_log_time_agent` / `idx_mcp_log_agent_time`)という状態を、`audit_events`側で是正(§2-1)。
- 保持期間ゼロの状態を、機構提供という形で是正(既定は自動削除なし、§7)。

---

## 2. マイグレーション内容(v126〜v128)

現行`LATEST_VERSION`は125(`principal_identity_foundation`、§0(a)のとおりコミット済み)。Phase 9Cはv126〜v128を追加する。

### 2-1. v126: `audit_event_foundation`

#### 登録表3つ(open-world、Phase 9Bの`principal_kinds`パターンを踏襲)

```sql
CREATE TABLE IF NOT EXISTS audit_event_kinds (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT);
INSERT INTO audit_event_kinds (id, label, description) VALUES
  ('operation.request','Operation Request','An actor requested an operation.'),
  ('authorization.decision','Authorization Decision','An authorization verdict was reached.'),
  ('credential.issue','Credential Issued','A credential was minted.'),
  ('credential.revoke','Credential Revoked','A credential was invalidated.'),
  ('credential.verify','Credential Verified','A presented credential was verified or rejected.'), -- (Phase 9Cでは未使用、将来の拡張点)
  ('client.register','Client Registered','A client record was created.'),
  ('client.update','Client Updated','A client record was modified.'),
  ('client.revoke','Client Revoked','A client record was revoked.'),
  ('session.establish','Session Established','An administrative session was established.'),
  ('session.terminate','Session Terminated','Sessions were terminated.'),
  ('delegation.grant','Delegation Granted','Authority was delegated to an execution instance.'),
  ('delegation.deny','Delegation Denied','A delegation attempt was refused.'),
  ('message.verify','Message Verified','Message authenticity was verified without subject authentication.'),
  ('ingest.accept','Ingest Accepted','Content was accepted for ingestion.'),
  ('ingest.reject','Ingest Rejected','Content was refused at ingestion.')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_channels (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT);
INSERT INTO audit_channels (id, label, description) VALUES
  ('mcp_http','MCP over HTTP','Remote MCP JSON-RPC endpoint.'),
  ('oauth_endpoint','OAuth Endpoint','Authorization/token/revocation endpoints.'),
  ('admin_http','Admin Console HTTP','Administrative console API.'),
  ('webhook','Inbound Webhook','Signature-verified inbound webhook.'),
  ('ingest_http','Ingest HTTP','Direct content ingestion endpoint.'),
  ('local_process','Local Process','In-process or local CLI invocation.'),
  ('internal','Internal','Emitted by gbrain itself with no external actor.'),
  ('mcp_stdio','MCP over stdio','MCP over stdio; a local pipe, in-process call that is nonetheless treated as remote:true. No per-token authentication concept exists for this channel.')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_attribution_states (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT);
-- 11状態をシード(下表参照)
```

`audit_attribution_states`にシードする11状態(詳細な設計意図は未帰属状態モデルのドメインモデル文書側が正本。本書ではマイグレーション対象として一覧のみ示す):

| id | 意味(要約) |
|----|-----------|
| `principal_attributed` | Client検証済み かつ `oauth_clients.principal_id`設定済み。`principal_id`列が入る唯一の状態 |
| `client_only` | Client検証済みだが`oauth_clients.principal_id IS NULL`(Phase 9Bが正当な既定と定めた状態) |
| `legacy_credential` | レガシー`access_tokens`経路。Client/Principalとは別ID空間であり構造的に帰属取得不可能(最も強い権限を持つ経路が最も帰属不可能) |
| `admin_session` | 管理画面のbootstrap-token保持者。`client_id`/`principal_id`という概念自体が存在しない平面 |
| `message_authenticated` | 主体認証を伴わないメッセージ真正性検証のみ(GitHub Webhook HMAC)。帰属先は`source_id` |
| `unauthenticated` | 資格情報が一切提示されずにハンドラへ到達(pre-auth拒否) |
| `authentication_failed` | 資格情報は提示されたが棄却(署名不一致・失効・期限切れ)。`unauthenticated`とは意図的に区別 |
| `system_internal` | 外部主体なしにgbrain自身が発行(scheduled worker・self-fix・retention job) |
| `local_process` | `ctx.remote === false`のローカル呼び出し。Phase 9Cでは計装しないが値はシードする(将来の計装をスキーマ変更ではなくデータ行追加で済ませるため) |
| `unmigrated_legacy_record` | Phase 9C以前のストレージ由来で帰属が構造的に復元不能な記録。**`audit_events`には決して書き込まれない**。互換ビューがレガシー行へ射影するためだけの定数(§1-2) |
| `attribution_unavailable` | 帰属を持つべき経路なのに書き込み時点で欠落していた。正常状態ではなく欠陥シグナル。`doctor`が非ゼロ件数を検知したら警告する |

#### `audit_events`本体

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_version  SMALLINT     NOT NULL DEFAULT 1,
  occurred_at       TIMESTAMPTZ  NOT NULL,
  recorded_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  event_kind        TEXT         NOT NULL REFERENCES audit_event_kinds(id),
  channel_id        TEXT         NOT NULL REFERENCES audit_channels(id),
  attribution_state TEXT         NOT NULL REFERENCES audit_attribution_states(id),
  principal_id      UUID         REFERENCES principals(id) ON DELETE RESTRICT,
  client_id         TEXT,
  actor_label       TEXT,
  credential_ref    TEXT,
  operation         TEXT         NOT NULL,
  required_scope    TEXT,
  scopes_snapshot   TEXT[],
  decision          TEXT         NOT NULL DEFAULT 'not_applicable'
                      CHECK (decision IN ('allowed','denied','not_applicable')),
  outcome           TEXT         NOT NULL
                      CHECK (outcome IN ('succeeded','failed','rejected','pending')),
  reason_code       TEXT,
  resource_kind     TEXT,
  resource_ref      TEXT,
  source_id         TEXT,
  job_id            INTEGER,
  correlation_id    TEXT         NOT NULL,
  parent_event_id   UUID,
  latency_ms        INTEGER,
  error_message     TEXT,
  params_summary    JSONB,
  adapter           JSONB        NOT NULL DEFAULT '{}',
  CONSTRAINT chk_audit_attribution
    CHECK ((attribution_state = 'principal_attributed') = (principal_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred
  ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_principal
  ON audit_events (principal_id, occurred_at DESC) WHERE principal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_client
  ON audit_events (client_id, occurred_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation
  ON audit_events (correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_job
  ON audit_events (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_denied
  ON audit_events (occurred_at DESC) WHERE decision = 'denied';
CREATE INDEX IF NOT EXISTS idx_audit_events_channel
  ON audit_events (channel_id, occurred_at DESC);
```

これに続けて、v37(`takes_and_synthesis_evidence`)と同形の実装パターンで`audit_events`のRLSを有効化する。**同一migration(v126)内で、`audit_event_kinds` / `audit_channels` / `audit_attribution_states`の3つのopen-world登録表にも同じ実装パターンでRLSを有効化する。`audit_events`がこれら3表へJOINする以上、未設定のまま出荷すると`dashboard-m1ja3`と同型のギャップを新規に生むため、同一migration内でRLSを設定する。**RLS有効化は、v37(`takes_and_synthesis_evidence`)の実装パターンを踏襲する: `sql`フィールドに『共通DDL(登録表・`audit_events`本体・インデックス)+ Postgres向けRLS有効化DOブロック』を全文含める。`sqlFor.pglite`には、同じ共通DDLからRLS有効化DOブロックのみを除いた同一内容を重複して記述する(`sqlFor`に`postgres`キーは設定しない。Postgresは`sqlFor.postgres`が存在しないため自動的に`sql`フィールドへフォールバックする)。これにより、Postgres側は共通DDL+RLSの両方が実行され、PGLite側は共通DDLのみ(RLSなし)が実行される。この分離を怠ると、PGLiteブレインでALTER TABLE ... ENABLE ROW LEVEL SECURITYの実行に失敗しブレインがwedgeする既知の障害パターン(issue #395)を再発する。test/migrate.test.tsの`expect(pgliteSql).not.toContain('rolbypassrls')`のようなパターンで、新規追加するSQLがPGLite側に混入していないことを機械的に検証する。

**インデックスを7本に絞った理由**: `attribution_state`単体のインデックスは作らない(§2-2の`audit_events_attribution_gaps`ビューは日次運用クエリでありシーケンシャルスキャンで足りるため、書き込みホットパスの負担を優先する)。`decision='denied'`の部分インデックスは対象行数が少なくセキュリティ調査での最頻クエリであるため残す。`idx_audit_events_channel (channel_id, occurred_at DESC)`は、`audit_events_compat`経由の4リーダー(`/admin/api/requests`・`/admin/api/agents`・`/admin/api/stats`・`/admin/api/health-indicators`)がいずれも`channel_id IN (...)`でフィルタする(§2-2)ため、書き込みホットパスの負担と引き換えても必要と判断した。

**`chk_audit_attribution`制約の役割**: 「帰属済みと言いながら`principal_id`が空」「`principal_id`があるのに帰属済みでない」の双方をDBレベルで拒否する。違反は`23514`として即座に露見する(§5でこの制約がbackfillゼロ原則をどう支えるかを補足)。

### 2-2. v127: `audit_events_compat_view`

```sql
CREATE OR REPLACE VIEW audit_events_compat AS
  SELECT id::text AS id, token_name, agent_name, operation, latency_ms,
         status, params, error_message, created_at,
         'unmigrated_legacy_record'::text AS attribution_state
    FROM mcp_request_log
  UNION ALL
  SELECT id::text, COALESCE(client_id, actor_label), actor_label, operation,
         latency_ms,
         CASE WHEN outcome = 'succeeded' THEN 'success' ELSE 'error' END,
         params_summary, error_message, occurred_at, attribution_state
    FROM audit_events
   WHERE channel_id IN ('mcp_http', 'ingest_http');

-- Postgres限定(sqlFor.pgliteには含めない。PGLiteはこの文脈でのRLSバイパス経路を持たない)。
-- v120(schema_lint_hardening_search_path_security_invoker)がpage_linksに対して適用した
-- のと同一パターン: security_invoker未指定のビューは既定でinvoker=false(所有者権限で評価)
-- となり、所有者がBYPASSRLSを持つ場合(schema.sql:1452)、RLSで本来ブロックされるべき
-- ロールもこのビュー経由でmcp_request_log/audit_eventsの全行を読めてしまう
-- (page_linksで一度発見・修正済みのRLSバイパスパターンの再発を防ぐ)。
ALTER VIEW IF EXISTS audit_events_compat SET (security_invoker = on);
```

**`channel_id`フィルタによる意図的な挙動変化**: Phase 9C導入後、`/ingest`の拒否・失敗行(IN-2で新規に記録される`channel_id='ingest_http'`の行)も、既存の成功行と同じ`channel_id`を持つため、`audit_events_compat`ビュー経由で`/admin/api/agents`・`/admin/api/stats`・`/admin/api/health-indicators`へも新たに算入される。これは**意図的な挙動変化**である: これらエンドポイントの応答スキーマ(契約)自体は不変だが、算出される値(`error_rate`等)は、従来無記録だった`/ingest`失敗が新たに可視化されることで変化しうる。これは監視精度の向上であり後退ではない。この挙動変化はStage6で明示的にテスト対象とする。

なお、durable spill/replay経由で再投入される行は`occurred_at`が障害発生時点のまま保持される(`recorded_at`との間に乖離が生じる)。`/admin/api/requests`の直近一覧は`occurred_at`で並び替えるため、spill由来行は実際に記録された時刻より古い時刻の行として表示されうる点に留意する。

`audit_events`側のSELECTには`WHERE channel_id IN ('mcp_http', 'ingest_http')`を設け、この2チャネル以外の`channel_id`を持つ行(OAuth/admin/webhook等)は`audit_events_compat`に現れないようにする。`audit_events_compat`は歴史的に`mcp_request_log`の後継であり、`mcp_request_log`が実際に記録していた範囲(MCP経由のリクエスト+ingestの成功。`PHASE9C-CURRENT-AUDIT-PATHS.md` §4が確認しているとおり、既存の`mcp_request_log`は「MCPリクエスト専用」ではなく、`/mcp`・`/mcp-v2`に加えて`/ingest`の成功(`operation='webhook_ingest'`)も記録していた)に合わせて、`mcp_http`と`ingest_http`の両チャネルを対象に含める。それ以外のチャネル(OAuth/admin/webhook)は元々`mcp_request_log`に書き込んでいなかったため対象外のままとする。OAuth/admin/webhook等の他channelの監査イベントを横断的に閲覧する新規ニーズには、`audit_events`テーブルを直接クエリする新しいUI/APIで対応する(本互換ビューの責務ではない)。

なお、`status`写像(`outcome='succeeded'` → `'success'`、それ以外 → `'error'`)について、`outcome='pending'`はPhase 9Cでは実データとして発生しないため(`PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md`参照)、本写像が実運用で`pending`を`error`へ丸めるケースは現状発生しない。

同じマイグレーションで`audit_events_attribution_gaps`ビューも作成する。内容と用途は§5-3を参照(読み取り側の非破壊的照合であり、書き戻しは一切行わない)。

### 2-3. v128: `rls_principal_tables`

`dashboard-m1ja3`(`principals`/`principal_kinds`がv24 RLS backfillの静的管理リストに未登録)を解消する。v37(`takes_and_synthesis_evidence`)と同形の実装パターンで`principals`/`principal_kinds`にRLSを有効化する。`audit_events`が`principals`へJOINする以上、ここを未設定のまま出荷すると監査データ経由でRLS未設定表が露出するため、Phase 9Cの実施範囲に含める。`mcp_spend_log`/`mcp_spend_reservations`のRLS設定は`audit_events`が参照しないためPhase 9C対象外(non-goal)。

RLS有効化は、v37(`takes_and_synthesis_evidence`)の実装パターンを踏襲する: `sql`フィールドに『共通DDL(`principals`/`principal_kinds`対象のALTER)+ Postgres向けRLS有効化DOブロック』を全文含める。`sqlFor.pglite`には、同じ共通DDLからRLS有効化DOブロックのみを除いた同一内容を重複して記述する(`sqlFor`に`postgres`キーは設定しない。Postgresは`sqlFor.postgres`が存在しないため自動的に`sql`フィールドへフォールバックする)。これにより、Postgres側は共通DDL+RLSの両方が実行され、PGLite側は共通DDLのみ(RLSなし)が実行される。この分離を怠ると、PGLiteブレインでALTER TABLE ... ENABLE ROW LEVEL SECURITYの実行に失敗しブレインがwedgeする既知の障害パターン(issue #395)を再発する。test/migrate.test.tsの`expect(pgliteSql).not.toContain('rolbypassrls')`のようなパターンで、新規追加するSQLがPGLite側に混入していないことを機械的に検証する。

---

## 3. FK方針

### 3-1. 原則: `ON DELETE RESTRICT`

Phase 9B(`oauth_clients.principal_id`)が確立した原則をそのまま踏襲する。`principal_id → principals(id) ON DELETE RESTRICT`。`principals`は設計上物理削除されず、`oauth_clients.principal_id`が既にRESTRICTであることと整合する。登録表3つ(`audit_event_kinds` / `audit_channels` / `audit_attribution_states`)へのFKも既定(登録行は削除しない)のままとする。

### 3-2. 3件の例外(Phase 9BのRESTRICT原則に対する明示的例外)

| 列 | FK | 根拠(既存の正当なDELETE操作の実例) |
|----|----|-----------------------------------|
| `client_id` | **FKを張らない**(非正規化列) | `src/commands/auth.ts:315`に`DELETE FROM oauth_clients WHERE client_id = ...`が実在する(soft delete用の`deleted_at`列があるにもかかわらず、hard delete経路が現に存在する)。RESTRICTを張ると監査行が1件でも残っている状態で既存のclient削除コマンドが壊れる。Phase 9Cでclient削除の意味論を変更すべきではない(§0(b)でユーザーがsoft delete統一を今回実施しないことを確定済み)。したがって`client_id`は「提示された時点の識別子」を保持する非正規化列として扱う。この件は独立のbdタスクとして登録し(soft delete統一→その後にFK追加)、発見事項として記録する(実施はPhase 9Cのnon-goal)。 |
| `job_id` | **FKを張らない** | `src/core/minions/queue.ts:385/926/1060`で`minion_jobs`行が物理DELETEされ、`remove_on_complete`設定も存在する。RESTRICTはキュー運用を壊し、CASCADEは監査履歴を破壊する。どちらも許容できないためFKを持たない。 |
| `parent_event_id` | **自己FKを張らない** | 長時間実行ジョブの子イベントが親イベントより後まで残るケースがあり、retention pruneの実行順序に依存した失敗が起こりうる。監査の完全性は「purgeできない」でも「INSERTできない」でもなく、「親がpurge済みであることが分かる」形で劣化すべきという設計判断による。ダングリング親が保持期間外由来であることを検証するテストを別途置く。 |

`source_id` / `resource_ref`も同じ単一基準(既存の正当な削除操作を壊さない)からFKなしとする。`sources`は`sources_remove`でhard deleteされ、`resource_ref`はpolymorphic(対象の型に依存)であるため。

3件の例外は個別の思いつきではなく、**「既存の正当な削除操作を壊さない」という単一基準**に基づく。実装時はこの基準に対応する各DELETE文の存在を固定するテストを置く。

---

## 4. PGLite/PostgreSQL両対応方針

Phase 9B v125で確立した手順を厳密に踏襲する。

- **3ファイルへの同一DDLインライン追加**: `src/schema.sql`(Postgres正本)・`src/core/pglite-schema.ts`(PGLite正本、手動同期)へ§2のDDLをそのままインライン追加する。`src/core/schema-embedded.ts`は`bun run build:schema`で`schema.sql`から再生成し、**手編集しない**。
- `gen_random_uuid()` / `TIMESTAMPTZ` / `TEXT[]` / `JSONB` / 部分インデックス / CHECK制約はいずれもv125の`principals`でPGLite実機通過済みであり、新規の互換リスクはない。
- **前方参照を新たに作らない**: `audit_event_kinds` / `audit_channels` / `audit_attribution_states` / `audit_events`はすべて`schema.sql`の`principals`ブロックより**後**に配置する。これにより、`PostgresEngine` / `PGLiteEngine`双方の`applyForwardReferenceBootstrap`への追加が不要になり、`test/schema-bootstrap-coverage.test.ts`の`REQUIRED_BOOTSTRAP_COVERAGE`への追加も**原則不要**になる。drift検知テストが失敗した場合に限り追加する(先回りして追加しない)。
- マイグレーションは`handler`ではなく**`sql:`文字列で書く**。v125の内部レビューで、handler経由だと本番マイグレーション実行時の3回リトライ・statement_timeout上書き・`57014`診断メッセージという安全機構を全てバイパスしてしまうことが判明した教訓をそのまま適用する。
- **`dashboard-r3be4`への対処**: Postgres側`verifySchema`の自己修復(`simplifyColumnDef`)がFK句を正規表現除去する既知欠陥がある。`audit_events`は新規テーブルであり自己修復のALTER TABLE ADD COLUMN経路の対象になりにくいが、「到達条件がレアだから安全」と推測で済ませず、`verifySchema`実行後に`audit_events.principal_id`のFKが実在することを確認するテストを実装時に明示的に追加する。
- `test/e2e/schema-drift.test.ts`(schema.sql/pglite-schema.ts/schema-embedded.ts間の同期を強制する既存CIガード)がこのままカバーする。新規に独立したドリフトテストをゼロから書く必要はない。

---

## 5. Backfill方針

### 5-1. 基本方針: `audit_events`へのbackfillは行わない(ゼロ行)

`audit_events`は**空の状態で開始する**。`mcp_request_log`の既存行から`audit_events`行を合成しない。帰属は**書き込み時点**でAuthInfo.principalId(OAuthパスでは既に取得済み)を直接INSERTへ渡すことで取得する。既存履歴は凍結された`mcp_request_log`にそのまま残り、互換ビュー経由で読める(§1)。

### 5-2. token_name由来の推測を採らない具体的根拠

- OAuth経路: `token_name = oauth_clients.client_id`と文字列完全一致するため、一見すると機械的導出が「可能」に見える。
- レガシー経路: `token_name = access_tokens.name`であり、`oauth_clients`とは無関係な別ID空間。
- **両者は`mcp_request_log.token_name`という同一の列に混在しており、値だけではどちらの空間に属するか判別できない**。`access_tokens.name`が偶然`client_id`と一致するケースを構文的に排除できない。したがって、v33で実装済みの`agent_name`バックフィルにおけるCOALESCEパターン(`oauth_clients` → `access_tokens` → 生の`token_name`の順で解決)をFK付与に流用すると、レガシー行をOAuth Clientへ誤帰属させる経路が原理的に開いてしまう。**監査データにおける誤帰属は欠落より有害である**(誤った証拠になる)ため、この方式は**採らない**。

### 5-3. `audit_events_attribution_gaps`ビュー

backfillを行わない代わりに、読み取り側の非破壊的照合手段として`audit_events_attribution_gaps`ビューを新設する(v127、§2-2)。

- 内容: `(channel_id, attribution_state, actor_label)`ごとの件数、最古/最新`occurred_at`、および**`LEFT JOIN oauth_clients`で導出した`inferred_client_id` / `inferred_client_name`**。
- 導出列は明示的に`inferred_`プレフィックスを付け、**ビュー上の派生値としてのみ存在し、決してテーブルへ書き戻さない**。
- 用途: 運用者が「`client_only`が急増している」「`legacy_credential`経由のadmin操作が月N件ある」といった実態を把握し、人間の判断で`oauth_clients.principal_id`を紐付ける(＝正しい根本対処)ための入力とする。
- レガシー行(`mcp_request_log`、`unmigrated_legacy_record`)も同じビューで集計できるようにし、移行前後の連続性を確保する。
- `audit_events_attribution_gaps`も`audit_events_compat`と同様、`oauth_clients`(RLS有効化済み、schema.sql:1497)へJOINするため、Postgres限定で`ALTER VIEW IF EXISTS audit_events_attribution_gaps SET (security_invoker = on);`を同一マイグレーション(v127)内で適用する(§2-2のRLSバイパス防止と同じ理由。実DDLはStage5実装時にこの2ビューへ一貫して適用すること)。

### 5-4. 「backfillでないもの」の明示

- 互換ビューがレガシー行へ`'unmigrated_legacy_record'`を射影するのは**射影であってbackfillではない**(1行もUPDATEしない)。この区別を実装・テストの命名に反映する。
- `oauth_clients.principal_id`自体の自動生成(Principal行の自動作成)は行わない。AUTHZ-INV-012(Client登録はPrincipalの信頼登録を意味しない)に反するため、Phase 9Cのnon-goalとする。
- `backfill_confidence` / `attribution_note`列は先行実装しない。backfillを行わない以上、confidence列は常に単一値になり死重になる。「なぜ帰属できていないか」は`attribution_state`(11状態、§2-1)が既に構造的に表現しており、連続値の確信度ではなく離散的分類の方が監査には正しい表現である。将来手動再帰属を行う場合に備えた`attribution_note`列は、その時点で`ALTER TABLE ADD COLUMN`により追加できる拡張点として記載するのみに留める。
- 歴史的監査行の一括再帰属コマンド(`gbrain audit attribute`相当)はPhase 9Cのnon-goal(誤帰属リスクが監査価値を上回るため、実施するなら人手レビュー付きの別waveとする)。

---

## 6. ロールバック手順の骨子

`PHASE9B-MIGRATION-AND-ROLLBACK.md`の形式をそのまま踏襲する。gbrainのマイグレーション機構はforward-onlyであり、down migrationの標準機構は存在しない(v125までの125件のマイグレーションいずれにも`down`相当のフィールドがない)ため、新たな自動ロールバック機構は追加せず、手動SQLを証跡として整備する。

### 6-1. 実行順序(Phase 9Bで発見された自己復元欠陥を最初から回避する)

Phase 9B(v125)のロールバック手順は当初SQLロールバックをコードロールバックより先に置いており、内部レビュー(v3改訂)で「コードが稼働したままSQLだけを実行すると、次回接続時に`initSchema()`が`applyForwardReferenceBootstrap`経由でオブジェクトを全て再作成し、ロールバックが数秒で自己復元(自己無効化)する」という重大な欠陥が発見された。本書は**この教訓を手順書の冒頭に最初から反映する**:

1. **全gbrainプロセスを停止する**(launchd管理のサーバー・MCPセッション・cron/dreamサイクル等すべて)。接続が残っていないことを確認する。
2. **コード側のロールバックを先に実施し、デプロイする**(§2のv126〜v128に対応するスキーマ変更・Writer実装・リーダー向け替えをすべて元に戻す)。
3. **その後でSQLロールバックを実行する。**
4. 必要ならサービスを再起動する。

コードが稼働したままSQLだけを単独実行することは、実質的に何も戻さない自己無効化操作である。

### 6-2. ロールバックSQLの骨子

```sql
-- v127分の取り消し
DROP VIEW IF EXISTS audit_events_attribution_gaps;
DROP VIEW IF EXISTS audit_events_compat;

-- v126分の取り消し(依存の逆順)
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS audit_attribution_states;
DROP TABLE IF EXISTS audit_channels;
DROP TABLE IF EXISTS audit_event_kinds;

-- config.versionの巻き戻し(v128まで適用済みの場合はv128分のRLS取り消しも別途必要)
UPDATE config SET value = '125' WHERE key = 'version';
```

`mcp_request_log`は§1のとおり物理的に一切変更していないため、このロールバックによる影響を受けない。したがって**ロールバック時のデータ損失は「Phase 9C稼働中に`audit_events`へ記録された監査行」に限定される**(損失ゼロとは言えない — Phase 9C稼働中に記録された監査履歴そのものは、事前にダンプしない限りロールバックで失われる)。

### 6-3. 検証

Phase 9B `§4-5`(実際に実行し検証した水準)と同じ水準で、実装時に上記ロールバックSQLを実際にPGLite上で`.exec()`により実行し、以下を確認する:

- `config.version`が期待どおり巻き戻ること。
- `audit_events` / 登録表3つ / 互換ビュー2つが実際に消失すること(カタログ照会+実クエリの両方)。
- ロールバック前に記録された`audit_events`行が失われる一方、`mcp_request_log`の既存行は無傷であること。
- `initSchema()`再実行でv126〜v128が完全に復元されること。

実Postgres環境でも同様の検証を行う(Phase 9B同様、postgres.jsの`sql.begin(async tx => {...})`経由でトランザクション内実行する)。

---

## 7. 保持期間

- `gbrain audit prune --older-than <days> [--dry-run]`コマンドを提供する。
- **既定では自動削除しない**(§0(d)、2026-08-02にユーザー確定)。監査記録の無言削除は増加放置より有害と判断した。`op_checkpoints`の7日パージ(`purgeStaleCheckpoints`)とはデータの性質が異なるため、同じ既定を踏襲しない。
- `doctor`は`audit_events`＋`mcp_request_log`の行数/サイズが閾値を超えたら警告する。増加を放置しないが、削除も強制しない。
- `gbrain audit prune`は`mcp_request_log`(凍結レガシー表)と`audit_events`の両方を対象として提供するが、実行は運用者の明示操作に限る。既定有効の自動retention jobはPhase 9Cのnon-goalとする。
