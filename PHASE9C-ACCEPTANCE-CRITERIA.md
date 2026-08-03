# Phase 9C — 受け入れ基準(Acceptance Criteria)

**日付**: 2026-08-02
**位置づけ**: 本書はStage6(実装後テスト)およびStage4/7(レビュー)がPASS/FAILを判定する基準を、実装前に固定するためのものである。Stage1(現状調査、6エージェント並列)とStage2(Opus設計)の結果に既に記録されている決定事項を整理・体系化したものであり、本書自体は新しい設計判断を行わない。設計の正本は`design.test_strategy`(Stage2)、根拠となる現状調査は`Stage1(key: E, tests-evidence)`である。

---

## 0. 前提: 2026-08-02付ユーザー確定事項

Stage2の`open_questions_for_user`4件は、以下のとおりユーザーが2026-08-02に確定した。本書の受入基準はこれを確定済み前提として組み込む(未決事項としては扱わない)。

- **(a) Phase 9B実装34ファイルは独立コミット済み(commit `fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。** Stage1調査時点(2026-08-02)ではPhase 9B実装34ファイルがworking treeに未コミットのまま存在していたが、これは解消済みである。**§4のbaseline取得は、この独立コミットを起点として行う**(未コミット状態を跨いだbaseline比較は行わない)。
- **(b) `oauth_clients`のhard delete→soft delete統一は今回は実施しない(Opus提案どおり)。** `client_id`はFKなし非正規化列のままとする。**§3の`test/audit-event-foundation.test.ts`は、`audit_events.client_id`にFK制約が存在しないこと自体を積極的な合格基準として検証する**(FKが付いていたら失敗するテストであること)。
- **(c) `/admin/api/*`の読み取り専用GET 11ルートは監査対象外のまま(Opus提案どおり)。** **§3の`test/audit-entrypoint-coverage.test.ts`の登録簿に、この11ルートを「意図的に監査しない経路」として明記し、登録簿とコード実態の一致を機械検証することを合格基準とする**。
- **(d) `gbrain audit prune`の既定は自動削除なし(Opus提案どおり)。** `--dry-run`なしで実行しても、期間指定なしでは監査行が削除されないことを受入条件に含める。専用テストファイルを新設するとは限らないが、Stage6のいずれかのテスト証跡(`test/audit-failure-policy.test.ts`またはCLI単体テスト)でこの既定動作が実測確認されていることを、Stage4/7レビューが独立に確認する。

---

## 1. Phase 9Cが満たすべき2つの到達目標と合格基準

Phase 9Cが到達すべき条件は`PHASE9A-AUTHORIZATION-INVARIANTS.md`のAUTHZ-INV-009とAUTHZ-INV-013の2つに限定する。他のAUTHZ-INV項目(001〜004等)は「壊さないこと」が条件であり、Phase 9Cが新たに満たすものではない(§3-5参照)。

### 1-1. AUTHZ-INV-009: 委任チェーンは監査で再構成できる

- **規則(原文)**: 「あるExecution Instanceについて、それがどの委任チェーン(どのPrincipal/Client→どのDelegation→どのExecution Instance)から生じたかを、監査ログから遡って再構成できなければならない。」
- **何を実行するか(PASSの手順)**:
  1. `submit_agent`をHTTP経由で呼び出し、ジョブを生成し、ジョブを完了させる。
  2. 同じ手順をstdio経由でも実行する(stdio経由は`ctx.auth`が常にundefinedのため`permission_denied`で拒否される — 拒否自体が`delegation.deny`イベントとして記録されることを含めて検証する)。
  3. `submit_agent`が委任を拒否するケース(binding不存在・boundTools不許可・slug_prefix不許可・concurrency超過等)を意図的に発生させる。
- **何が確認できればPASSか**:
  - 生成された`job_id`から、それを生成した`submit_agent`呼び出しの`audit_events`行(`event_kind='delegation.grant'`)を一意に特定できる。
  - 逆方向(`delegation.grant`イベント→そのイベントが生んだ`job_id`)にも辿れる。
  - この双方向の再構成が`audit_events`**のみ**から可能である(`mcp_request_log`や`agent-audit.ts`のJSONLを参照せずに完結する)。
  - HTTP経由・stdio経由のいずれの委任呼び出しも`audit_events`に記録される(トランスポート非依存の計装であることの確認)。
  - 委任拒否(`delegation.deny`)も同様に記録され、成功(`delegation.grant`)と拒否が別のイベント種別として区別できる。
- **対応テスト**: `test/audit-delegation-chain.test.ts`(§3-8)。

### 1-2. AUTHZ-INV-013: 監査イベントは成功・拒否・失敗のいずれも記録され、欠落は明示的に検知可能である

- **規則(原文)**: 「認可判断の結果(成功・拒否・失敗)は、いずれも何らかの監査記録として残す。ある経路が監査記録を欠いている場合、それは意図的な設計として明示的に文書化され、偶発的な見落としとして放置されない。」
- **何を実行するか(PASSの手順)**:
  1. `scope_boundary`が対象(IN)と定めた6経路(POST /mcp・/mcp-v2、POST /ingest、/authorize・/token・/revoke、admin Authority変更9ルート、POST /webhooks/github、submit_agent)それぞれについて、成功・拒否・失敗を意図的に発生させる。
  2. `failure_policy`のクラス1〜3それぞれについて、監査書き込み自体を失敗注入エンジンスタブで失敗させる。
  3. 対象外(OUT)と宣言された経路のうち、機械検証が可能なHTTPエントリポイント(admin GET 11ルート)に新規エントリポイントを追加してみる(登録簿drift検知の確認)。stdio一般操作・ローカルCLI・15+運用診断JSONLモジュールはHTTPエントリポイントとして実装されていないため機械的drift検知の対象外であり、テキストとしての登録簿・non-goals宣言・コードレビューによって担保する(§3項番10参照)。
- **何が確認できればPASSか**:
  - 対象(IN)6経路の成功・拒否・失敗の全分岐で、対応する`audit_events`行(またはspill経由での記録)が生成される。
  - クラス1発行系(Authority状態変更・権限付与)について: (a) DB書き込みを伴う状態変更は、監査INSERT失敗時に状態変更自体もロールバックされることを直接検証する(同一トランザクション内であることをテストで確認)。(b) インメモリ状態変更(issue-magic-link・POST /admin/login・GET /admin/auth/:tokenのadminSessions/magicLinkNonces等)を伴う経路については、監査INSERT・spillの両方が失敗した場合に実際の状態変更(例: adminSessions.set)が一切実行されていないことを直接検証し、かつクライアントへは503が返ることを確認する。ORではなくAND(状態変更なし かつ 適切なエラー応答)を合格条件とする(「変更されたが記録されていない」が発生しないことをANDで保証する)。
  - クラス1失効系(/revoke・api-keys/revoke・revoke-client・sign-out-everywhere)について: 監査INSERT・spillの両方が失敗しても、失効(状態変更)自体は必ず実行されることを直接検証する(発行系とは逆に、状態変更なしをANDではなく「失効が必ず実行される」ことを合格条件とする)。かつ二重障害時は`audit-critical-failures.log`への書き込みが行われることを確認する。
  - クラス2(拒否・認証失敗): 監査が書けなくても拒否レスポンスはそのまま返り、5xxへ変換されない。かつ監査が書けなかった事実はカウンタ・spillで握りつぶされない。
  - クラス3(成功): fail-openするが、spillファイルが生成され`audit_write_failures_total`が増分する。
  - `gbrain audit replay-spill`が同一UUIDを`ON CONFLICT DO NOTHING`で二重投入しない(冪等性)。破損・不正形式のspill行は無言でスキップされず、隔離ファイル`audit-spill-corrupt.jsonl`へ退避されカウンタが増分され、残りの正常行の処理は継続することを直接検証する。
  - `gbrain doctor`と`/admin/api/health-indicators`が`audit_write_failures_total`・`audit_spill_pending`・`audit-spill-corrupt.jsonl`の非空を報告し、**spillが非空、またはaudit-spill-corrupt.jsonlが非空なら`doctor`が非ゼロ終了する**。
  - 「対象外(OUT)」の経路一覧(登録簿)のうち、HTTPエントリポイントとして実装されている範囲(admin GET 11ルート等)についてはコード実態と一致することが機械的に検証され、登録簿に載っていない新規HTTPエントリポイントを追加すると検証が失敗する。stdio一般操作・ローカルCLI・15+運用診断JSONLモジュールはこの機械検証の対象外であり、テキストとしての登録簿・non-goals宣言・コードレビューによって担保する。
- **対応テスト**: `test/audit-failure-policy.test.ts`(§3-6)、`test/audit-entrypoint-coverage.test.ts`(§3-10)、`test/audit-event-generation.test.ts`(§3-11)。

---

## 2. 認可不変条件(AUTHZ-INV-001/004)が壊れていないことの合格基準

Phase 9Cは監査書き込みを追加するが、認可判定ロジックには一切影響してはならない(`PHASE9A-AUTHORIZATION-INVARIANTS.md`、`PHASE9C-PREREQUISITES.md`§2-1)。

- 同一scopes・異なる`attribution_state`のうち、`authorizeOperation()`経路に実際に到達しうる9状態(`admin_session`は`requireAdmin`が`hasScope`/`authorizeOperation`を一切呼び出さない別認可平面のため到達不能、`unmigrated_legacy_record`は互換ビュー専用の射影定数であり生きた操作実行に紐づく状態ではないため対象外——両状態とも`PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md`§6が定める構造的分離自体で担保される)で同一操作を実行し、認可結果が完全に一致すること。
- `scope.ts`/`operations.ts`の認可判定パスに`audit_events`/`attribution_state`/`principal_id`/`channel_id`のいずれの参照も現れないことをgrepベースの静的テストで機械的に強制すること。grep対象は`scope.ts`/`operations.ts`に加え、`src/commands/serve-http.ts`内の`requireAdmin`関数本体(および同ファイル内でPhase 9Cが新設する監査計装コード)も含める。
- 監査書き込みが失敗した状態でも認可結果が変わらないこと(fail-openが「拒否を許可に変える」方向へ倒れないことの直接検証)。
- **対応テスト**: `test/authorization-invariant-matrix.test.ts`の拡張(既存ファイル、§3-5)。

---

## 3. 新規/拡張テストファイル一覧

Phase 9B(Universal Identity Foundation)が確立した「4点セット」の命名・構造パターンをそのまま踏襲し(`principal-*` → `audit-*`)、Phase 9C固有の3領域(失敗ポリシー・redaction・委任チェーン)+登録簿検証+互換ビュー検証+監査イベント生成の直接検証を追加する。計11ファイル程度(既存2ファイルへの条件付きエントリ追加を除く)。

| # | ファイル | 種別 | 証明する内容 |
|---|---|---|---|
| 1 | `test/audit-event-foundation.test.ts` | 新規・PGLite単体 | スキーマ形状、登録表3つ(`audit_event_kinds`/`audit_channels`/`audit_attribution_states`)のシード内容、CHECK集合(`decision`/`outcome`)、`chk_audit_attribution`の双方向違反が23514で弾かれること、FKの`ON DELETE RESTRICT`挙動、`client_id`にFKが存在しないこと(§0-b)、Writerの帰属状態決定ロジックを証明する。 |
| 2 | `test/e2e/audit-event-postgres.test.ts` | 新規・実Postgres E2E | `DATABASE_URL`未設定時はskip(`test/e2e/principal-postgres.test.ts`と同形)。RLS有効化、部分インデックスの実在、`TEXT[]`/`JSONB`の往復を証明する。実Postgres環境でのロールバックSQL実行検証(postgres.jsの`sql.begin(async tx => {...})`経由でトランザクション内実行、Phase 9Bの`test/e2e/principal-postgres.test.ts`前例踏襲)も本ファイルの検証範囲に含める。 |
| 3 | `test/audit-event-schema-parity.test.ts` | 新規・parity検証 | fresh schema(`schema.sql`/`pglite-schema.ts`のインライン定義を直接実行)とmigrated schema(v1→v128連続適用)の一致を、列・型・NOT NULL・既定値・CHECK・**FK・インデックス**まで比較して証明する(Phase 9Bのparityテストより粒度を上げ、`dashboard-r3be4`の再発検知を兼ねる)。 |
| 4 | `test/audit-event-rollback-pglite.test.ts` | 新規・rollback実行検証 | `PHASE9C`のMIGRATION-AND-ROLLBACKドキュメント記載のロールバックSQLを**実際に実行**して検証する。加えて「コードロールバックより先にSQLを実行するとinitSchema()が再作成してしまう」自己復元欠陥(Phase 9B v3で発見)の回帰テストを固定する。 |
| 5 | `test/authorization-invariant-matrix.test.ts`(既存拡張) | 拡張・grep静的検証+パラメタライズド | §2の合格基準(AUTHZ-INV-001/004の維持)を証明する。 |
| 6 | `test/audit-failure-policy.test.ts` | 新規・失敗注入 | §1-2のクラス1〜3の失敗ポリシー、`replay-spill`の冪等性、`doctor`のspill非空時非ゼロ終了を証明する。 |
| 7 | `test/audit-redaction.test.ts` | 新規・テーブル駆動/property的 | access token/refresh token/authorization code/code_verifier/code_challenge/client_secret/Cookie/Authorizationヘッダ/`gbrain_cs_`/`gbrain_code_`/JWT/資格情報埋め込みURL/`sk-`/`ghp_`/`AKIA`/PEM秘密鍵ヘッダー/32文字超hex/webhook_secret/URL埋め込み形式のパスワード・DB接続文字列/bootstrap token/magic-link token/Set-Cookieを各入力経路へ投入し、**シリアライズした行全体**に禁止パターンが1つも出現しないことを証明する(`PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md` §5-1(絶対保存禁止対象)と§5-2(error_message専用パターン)の両方を合わせた対象と一致させる)。**任意形式(URL埋め込みでない自由記述)のフリーテキストパスワードは、§5-2が明示する既知の残存限界であり、本テストの対象外とする**(構文的パターンマッチで検出不可能なため)。サイズ上限truncate、`--log-full-params`がOAuth/admin/webhook/delegationイベントへ波及しないことも含む。 |
| 8 | `test/audit-delegation-chain.test.ts` | 新規・結合テスト | §1-1(AUTHZ-INV-009)の合格基準を証明する。 |
| 9 | `test/audit-compat-view.test.ts` | 新規・互換性検証 | レガシー行(`mcp_request_log`)と新行(`audit_events`)が`audit_events_compat`ビューで両方見えること、`status`写像、レガシー行の`attribution_state`射影(`unmigrated_legacy_record`)、`/admin/api/requests`だけでなく`/admin/api/agents`・`/admin/api/stats`・`/admin/api/health-indicators`についても応答スキーマ(契約)が不変であることを証明する。加えて、`/ingest`の拒否・失敗行(新たに記録される`channel_id='ingest_http'`の行)が、これら3エンドポイントの計算値(error_rate等)に新たに反映される(従来の成功のみカウントから、ingest失敗も含めたより正確な値へ変化する)ことを、意図的な挙動変化として明示的にテストで検証する(値が「変わらない」ことではなく「意図した通りに変わる」ことを確認する)。v0.26.3の永続化回帰アサーション(`tools/list`+`tools/call`後に2行以上)を互換ビュー経由で再現する。 |
| 10 | `test/audit-entrypoint-coverage.test.ts` | 新規・登録簿drift検証 | §1-2・§0-cの合格基準(「監査する経路」「意図的に監査しない経路」の登録簿とコード実態の一致)を証明する。機械的drift検知(Expressルーティングスタックのイントロスペクション)が保証するのは、HTTPエントリポイントとして実装されているIN/OUT経路のみ。stdio MCPの一般操作・ローカルCLI・15+運用診断JSONLモジュールは、この機構では検知できず、テキストとしての登録簿・non-goals宣言・コードレビューによって担保する。トランスポート非依存の`submit_agent`(IN-6)は、`test/audit-delegation-chain.test.ts`が個別に検証する。「コード実態」の独立検証は、Expressのルーティングスタック(`app.router.stack`。Express 5系では`app._router`は存在せず`app.router`からアクセスする。実インストール版(express ^5.1.0)で`app._router`が`undefined`であることを直接検証済み)の実行時イントロスペクションのみを用いる(`entrypoint-registry.ts`自身と比較する実装は禁止する——`entrypoint-registry.ts`は登録簿の宣言側であり、独立した検証ソースにはなり得ない)。`PHASE9C-IMPLEMENTATION-SCOPE.md`§2-2が定めるとおり、ルート登録処理自体が`entrypoint-registry.ts`を経由または照合する設計にした上で、`test/audit-entrypoint-coverage.test.ts`はExpressの実行時ルーティングスタックを列挙し、`entrypoint-registry.ts`に記載のない未知のルートが存在しないことを機械的に検証する。 |
| 11 | `test/audit-event-generation.test.ts` | 新規・IN経路の実挙動検証 | IN対象6経路(POST /mcp・/mcp-v2、POST /ingest、/authorize・/token・/revoke、admin Authority変更9ルート、POST /webhooks/github、`submit_agent`)それぞれについて、正常運行時(故障注入なし)の成功・拒否・失敗の代表的な分岐で、期待される`event_kind`/`channel_id`/`decision`/`outcome`を持つ`audit_events`行が実際に生成されることを直接検証する。AUTHZ-INV-013のPASS条件(§1-2)を直接担保する専用テストであり、`audit-failure-policy.test.ts`(故障注入時の挙動)・`audit-entrypoint-coverage.test.ts`(登録簿とルート存在の一致)とは異なる観点をカバーする。 |

**登録エントリ方式(既存ファイルへの条件付き追加、新規ファイルではない)**: `test/schema-bootstrap-coverage.test.ts`と`test/e2e/postgres-bootstrap.test.ts`へのエントリ追加は、Phase 9Cが前方参照を新設した場合**のみ**行う(`migration_and_schema_plan`の方針により、新オブジェクトはすべて`schema.sql`のprincipalブロックより後に置くため原則不要)。drift検証が失敗した場合に限り追加する、という順序を受入基準とする(先回りしての追加は不要)。

**既存回帰テストの更新計画(カットオーバー対応)**: 既存の`test/e2e/serve-http-oauth.test.ts:733`(v0.26.3永続化回帰テスト)は、現状`mcp_request_log`を直接SELECTしている。カットオーバー後(`mcp_request_log`への新規INSERTがゼロになった後)はこのSELECTを`audit_events_compat`(互換ビュー)参照へ書き換える必要がある。これはPhase 9Cによる意図的な変更として事前宣言し、baseline比較において「説明済みの変更」として扱う(無関係な新規失敗として扱わない)。

---

## 4. Baseline運用

- **シャード単位の目視突合を禁止し、テスト名レベルの機械diffを必須とする。** Phase 9B(`PHASE9B-TEST-EVIDENCE.md`v1→v7)が7ラウンドの訂正を要した主因は、baseline/patched比較を初期ラウンドでshard単位のpass/fail件数の目視突き合わせだけで行い、patched側のみの追加失敗を複数回見落としたことにある(v2:3件、v3:2件)。Phase 9Bのv4以降で採用された、テスト名レベルの機械diff手法(`extract_fails.py`/`diff_fails.py`相当、生ログから`(fail)`行をテスト名単位で機械抽出しdiffする)を踏襲する。ただしこれらのスクリプト自体はgbrainリポジトリに現存しないため、Phase 9C初回のbaseline取得時に同等の機能を持つスクリプトを新規に作成し、`scripts/`配下へコミットすること。
- **事前宣言済みの既知baseline失敗(2ファイル、個別失敗テストケースは計3件: `test/core/retry.test.ts` 1件+`test/scripts/run-unit-parallel.test.ts` 2件)**(Stage1 key:E、`tests-evidence`が2026-08-02に実行確認済み):
  1. `test/core/retry.test.ts` — 1件失敗。`BATCH_AUDIT_SITES`期待値のSetに`'mcp.put_page.remote_auto'`が欠落(src側94行目には定義済み)。Beads `dashboard-2vepx`。実行結果: 36 pass / 1 fail / 194 expect() calls。
  2. `test/scripts/run-unit-parallel.test.ts` — 2件失敗。`run-unit-parallel.sh`ラッパー自己テストが終了コード0を期待し1を受け取る(`exits zero when all shards pass`、`clears .context/test-failures.log to empty when all shards pass`)。Beads `dashboard-nc8tl`。実行結果: 4 pass / 2 fail / 13 expect() calls。
  - 両者とも`src/`配下のPhase 9B変更を一切含まない現在の作業ツリーでも再現することが確認済みであり、Phase 9B/9Cいずれの実装にも起因しない既存のドリフトである。
- Phase 9Cのbaseline取得でもこの2ファイル・個別失敗テストケース計3件(内訳は上記)の失敗は出現する前提とし、**事前に既知として宣言してから**patched側との差分を取る。新規失敗として誤認しないこと自体を受入基準とする。
- `scripts/run-unit-parallel.sh`のシャードタイムアウト(既定`GBRAIN_TEST_SHARD_TIMEOUT=1500`秒=25分)に留意する。Phase 9Cで新規テストファイル11本前後が追加されシャード実測時間が伸びる場合、事前にマージンを見積もり、`rc=143`(SIGTERMによる強制終了)を新規テスト由来の失敗と誤認しないこと。
- 静的チェック(`check-search-path.sh`/`check-jsonb-pattern.sh`/`check-admin-scope-drift.sh`/新設`check-audit-registry-drift.sh`、§6参照)の実行結果をPhase 9Bと同じくbaseline証跡に含める。

---

## 5. Stage4(設計レビュー)・Stage7(内部敵対的レビュー)の「REQUIRED=0」の定義

Stage4・Stage7のいずれも、以下の運用でREQUIRED=0を判定する:

- 各専門Reviewerは、本書§1〜§4の受入基準に対して独立に**PASS / WARNING / REQUIRED / 未確認範囲 / 権限不足**のいずれかを報告する。
- **REQUIRED=0**とは、その時点でReviewer全員の報告のうちREQUIRED判定が1件も存在しない状態を指す。
- REQUIREDが1件でも残っている場合、Correction Pass(指摘への対応)→再提出のサイクルを繰り返し、REQUIRED=0になるまでStage4/Stage7を完了扱いにしない。
- WARNING・未確認範囲・権限不足はREQUIRED=0の判定自体を妨げないが、放置してよいという意味ではない。記録した上で次ラウンドで解消するか、対応しない場合はその理由を明記する。
- この運用はPhase 9B(`PHASE9B-REVIEW-MANIFEST.md`§14〜§15)で実施したReview Bundle方式(複数ラウンド)と同一のREQUIRED=0判定ロジックを踏襲する。ただしReviewer構成はStage4/Stage7で異なる(`PHASE9C-EVIDENCE-MANIFEST.md`§6参照): Stage4(設計レビュー)は7専門領域(Architecture/Security-Privacy/Database-Migration/Reliability-Durability/Compatibility/Performance/Testing)。Stage7(内部敵対的レビュー、実装後)は10専門領域(Architecture/Security-Privacy/Database/Migration/Reliability-Durability/Compatibility/Performance/Testing/Documentation/Bundle Consistency)とする——Stage4の7領域のうちDatabase-MigrationをDatabase/Migrationの2領域に分割し、実装物に対して独立検証が必要なDocumentation・Bundle Consistencyの2領域を新設する(7-1+2+2=10)。Compatibility(audit_events_compatビュー・既存リーダー向け替え・v0.26.3回帰テスト等、実装完了後にこそ独立検証が必要な領域)はStage4から引き続きStage7でも維持する。両ステージともREQUIRED=0の判定ロジック自体は共通。

---

## 6. 静的チェックスクリプトの追加(受入条件)

既存パターン(`check-search-path.sh`、`check-jsonb-pattern.sh`、`check-admin-scope-drift.sh`)に倣い、`scripts/check-audit-registry-drift.sh`の新規追加をPhase 9Cの受入条件に含める。

- **内容**: TS側のイベント種別・チャネル・帰属状態のunion型定義(コード側)と、`audit_event_kinds`/`audit_channels`/`audit_attribution_states`の3登録表のシード行(DB側)の一致を機械検証する。
- **終了コード規約**: `check-admin-scope-drift.sh`と同一(0=一致、1=drift検出、2=内部エラー〈ファイル欠落・パース失敗〉)。
- **配線**: `bun run verify`および`bun run check:all`に組み込む。
- **受入条件**: Stage6のテスト証跡・Stage4/Stage7のレビュー証跡のいずれにも、このスクリプトの実行結果(exit 0)を含めることを必須とする。

---

## 7. 本書が対象外とする事項

本書はStage6/Stage4/Stage7の合否判定基準の固定のみを目的とし、以下は対象外(non-goalsはStage2 `design.non_goals`が正、本書はそこから受入基準に直結する範囲のみを反映する):

- テスト実装そのもの(Red/Green化)は本書の対象外。本書は「何を実行し何が確認できればPASSか」の基準を固定するのみ。
- Organization/Tenant・Delegationテーブル・改ざん検知等、Phase 9Cのnon-goalsに属する機能の受入基準は定義しない(そもそも実装しないため)。
- `oauth-diagnostic.ts`の削除・env フラグ化、`agent-audit.ts`のJSONL撤去、`mcp_spend_log`/`mcp_spend_reservations`のRLS設定は、Phase 9Cのnon-goalsであり本書の受入基準にも含めない。
