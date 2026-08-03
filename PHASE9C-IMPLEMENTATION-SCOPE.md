# Phase 9C — Universal Audit Event Integration 実装スコープ

**日付**: 2026-08-02
**位置づけ**: 本書は Phase 9C(Audit Event統合)の Stage 1(現状調査、6エージェント並列)および Stage 2(Opusによる正式設計)の結果を体系化し、実装スコープとして確定させる文書である。新たな設計判断はここでは行わない。Stage 1/Stage 2 が既に導出した決定事項を整理・文書化するにとどめる。実装(コード変更)はまだ開始していない。

---

## 1. 対象判定の中核原則

あるイベントを `audit_events` に記録するかどうかは、次の一文だけで判定する。

> 「主体が権限を行使しようとした試み」または「Identity/Credential/Authority の状態変化」を記録するイベントか？ — YES なら Phase 9C 対象、NO なら対象外。

この一文が対象経路の選定・JSONLの2クラス分割・T-todo-3との境界・`mcp_request_log`の扱い・除外の正当化のすべてを同じ論理で導く。これにより「監査」という語の多義性(セキュリティ監査証跡 vs 運用テレメトリ)を構造的に分離し、T-todo-3(既存の運用診断JSONL統合計画、TODOS.md記載)との重複を消す。

---

## 2. 対象経路(IN / OUT)

### 2-1. 対象に含める経路(IN)

| # | 経路 | 内容 |
|---|------|------|
| 1 | POST /mcp・/mcp-v2 | 現在の主要監査経路。既存6箇所(`src/commands/serve-http.ts`)の INSERT を新Writerへ移行。tools/list、tools/call の成功・unknown op・scope拒否・実行エラーの全分岐。既存7箇所のうち残る1箇所(2407行、`operation='webhook_ingest'`)は POST /ingest の既存成功記録であり、IN-2(下記)の対象。 |
| 2 | POST /ingest の拒否・失敗分岐 | AUTHZ-INV-013 が明記する非対称の解消。成功パスは既存記録があるが(IN-1で言及した既存7箇所目、2407行、`operation='webhook_ingest'`)、バリデーション拒否・キュー投入失敗は現状無記録。差分は数十行。 |
| 3 | GET/POST /authorize・POST /token・POST /revoke | Credential のライフサイクルそのもの。現状恒久監査がゼロで、唯一の記録が一時診断モジュール(oauth-diagnostic.ts)。監査価値が最も高い経路。 |
| 4 | /admin/api/* のうち Authority 状態を変更する9ルート(issue-magic-link、api-keys POST、api-keys/revoke、register-client、update-client-ttl、revoke-client、sign-out-everywhere、および `/admin/api/*` プレフィックス外の独立ルートである POST /admin/login(`src/commands/serve-http.ts:1231`、bootstrap token直接ログイン)・GET /admin/auth/:token(同`:1324`、マジックリンク償還)。いずれも `adminSessions`(インメモリMap、最強権限の管理セッション)を確立する経路) | 「adminが何をしたか」が現在完全に記録されていない。監査のみ追加し、requireAdmin の認可挙動は一切変えない(AUTHZ-INV-010 の是正はPhase 9D)。POST /admin/login・GET /admin/auth/:token は、v126で既にシード済みの `event_kind=session.establish`(成功時)・`session.terminate`(失効時、既存のsign-out-everywhereが対応)を実際に発行する対象とする。`channel_id='admin_http'`。成功(有効なbootstrap token/有効な未消費マジックリンクnonce → `decision=allowed`, `outcome=succeeded`)・失敗(不正なbootstrap token/期限切れ・使用済み・無効なnonce → `decision=denied`, `outcome=failed`)に分岐する。failure_policy分類はクラス1発行系(fail-closed)。 |
| 5 | POST /webhooks/github | HMAC検証の成功・失敗・未知source。Principal帰属を持たない主体を扱うテストケースとして、open-worldモデルを検証する役割も持つ。 |
| 6 | submit_agent(トランスポート非依存、`operations.ts` 層で計装) | AUTHZ-INV-009(委任チェーン再構成)の到達要件。HTTP経由/stdio経由を問わず委任イベントとして記録する。 |

**`credential.verify`(`event_kind`)について**: `credential.verify` は v126 で `event_kind` 登録表にシード済みだが、上記IN経路のいずれの発行元にも対応しない。Phase 9C では実際には発行されない — v126でのシードは将来の拡張点としてのものであり、Phase 9Cのいかなる書き込みコードもこの `event_kind` をINSERTしない。特に `verifyAccessToken()`(全MCP/HTTPリクエストで呼ばれる最高頻度パス)には一切の監査計装を追加しない。これは §6 non-goal #20(同関数の認証往復回数を増やさない)と整合する。

### 2-2. 対象に含めない経路(OUT・意図的な設計判断)

| # | 経路 | 除外理由 |
|---|------|----------|
| 1 | stdio MCP の一般操作 | `ctx.auth` が常に undefined で認可判定自体が存在せず、記録すべき「権限行使の試み」がない。全操作を記録すると利用者自身のPGLiteへ大量行を書き込むだけになる。ただし委任イベント(submit_agent)は上記IN-6で対象。 |
| 2 | ローカルCLI | 同上。認可モデルはOS境界への委譲であり(AUTHZ-INV-011)、gbrain層の主体が存在しない。 |
| 3 | /admin/api/* の読み取り専用GET 11ルート | Authority状態を変えない。jobs/watch・health-indicators は高頻度ポーリングであり、記録すると監査表を汚染する。 |
| 4 | 運用診断JSONLモジュール(rerank / shell / supervisor / slug-fallback / phantom / graph-signals / lease-pressure / backpressure / pool-recovery / batch-retry / self-upgrade / db-disconnect / lock-renewal / content-sanity / schema-pack 系ほか。調査時点で18個以上確認済み) | 対象外(OUT)の判定はモジュールの個別列挙・正確な総数把握ではなく、カテゴリ基準(主体も認可判定も存在しない、gbrain自身の内部健全性テレメトリであるかどうか)による。正確な総数把握はPhase 9Cの設計判断に影響しない(カテゴリ全体が対象外であるため、個別モジュールの漏れがあってもnon-goalの妥当性自体は変わらない)。正確な総数把握・網羅的listingはT-todo-3の所有領域(§3参照)。 |

**除外は「見落とし」ではなく「明示的設計」として扱う**(AUTHZ-INV-013 の要求そのもの)。除外経路に対応する帰属状態値 `local_process` は Phase 9C 時点でシード済みにし、将来の計装がスキーマ変更ではなくデータ行追加で済むようにする。

これに加えて、docs に**「意図的に監査しない経路の登録簿」**を置く。Stage 6(テスト戦略)では `test/audit-entrypoint-coverage.test.ts` がこの登録簿とコード実態の一致を機械的に検証する — 新規エントリポイントを追加して登録簿への記載を忘れると、このテストが失敗する構造にする。これが「偶発的な見落としとして放置されない」ことを保証する唯一の手段である。

登録簿はコードから独立した第二のリストであってはならない。実装方針として、gbrainのルート定義(app.get/app.post等)を集約する単一のTypeScriptモジュール(例: `src/core/audit/entrypoint-registry.ts`)を新設し、IN対象経路・OUT対象経路をそこに宣言する。ルート登録処理自体がこのレジストリを経由する(またはレジストリと照合するassertionを起動時に持つ)ことで、レジストリはコード実態そのものの一部になる。`test/audit-entrypoint-coverage.test.ts` は、Expressのルーティングスタック(`app.router.stack`。Express 5系では`app._router`は存在せず`app.router`からアクセスする)を実行時に列挙し、レジストリに記載のない未知のルートが存在しないことを機械的に検証する。

登録簿drift検知の機械的保証(Expressルーティングスタックのイントロスペクション)が有効なのは、HTTPエントリポイントとして実装されているIN/OUT経路(POST /mcp・/mcp-v2・/ingest・/authorize・/token・/revoke・admin9ルート・webhooks/github・admin GET11ルート)に限られる。stdio MCPの一般操作・ローカルCLI・運用診断JSONLモジュールはExpressのルーティング機構を経由しないため、この機械的drift検知の対象にはならない——これらの対象外指定は、テキストとしての登録簿・non-goals宣言・コードレビュー時の確認によって担保する(実行時イントロスペクションによる機械的担保ではない)。トランスポート非依存のsubmit_agent(IN-6)については、submit_agentという単一の既知オペレーションハンドラの呼び出し箇所を対象にした専用テスト(`test/audit-delegation-chain.test.ts`)で個別に担保する。

### 2-3. 併せて Phase 9C に含める周辺項目

対象経路そのものではないが、上記IN経路の実装に付随して Phase 9C のスコープに含める:

- `audit_events` への RLS 有効化(`mcp_request_log` と同水準)。
- `dashboard-m1ja3`(`principals`/`principal_kinds` が v24 RLS backfill の静的管理リストに未登録)の解消。`audit_events` が `principals` へ JOIN するため、ここで解消しないと監査データ経由でRLS未設定表が露出する。3行の追加で済む。
- `mcp_request_log` の無制限増加に対する運用手段(`gbrain audit prune`。既定は自動削除なし — §7(d)参照)。

---

## 3. T-todo-3 との関係(重複解消の明示的合意)

- Phase 9C は `audit_events`(セキュリティ監査証跡)を作る。T-todo-3(`TODOS.md` 記載、既存の運用診断JSONL統合計画)は `event_log`(運用テレメトリ)を作る。両者は**別テーブル・別保持方針・別RLS方針**。
- Phase 9C は T-todo-3 が再利用する共通基盤(durable spill writer プリミティブ、DB書き込み失敗カウンタ、doctor 連携点)を提供する。T-todo-3 はそれを `createAuditWriter` 側から利用するだけでよくなり、重複実装を避けられる。
- **例外**: `agent-audit.ts`(submit_agent の委任ログ)は T-todo-3 の6モジュール一覧には含まれない。TODOS.md:2467 が明記する T-todo-3 の6モジュール(rerank / shell / supervisor / slug-fallback / phantom / graph-signals、いずれも `createAuditWriter()` 使用)に `agent-audit.ts` は含まれておらず、`agent-audit.ts` は独自の `fs.appendFileSync` 実装で `createAuditWriter()` を使わない別系統である(TODOS.md:2467確認済み)。ただし同種のJSONL監査という点で T-todo-3 と隣接領域にあり、Phase 9C は§1の判定基準(主体の権限行使/Authority状態変化)に該当するため、T-todo-3 の対象かどうかに関わらず独立して `audit_events` 側に正本を作る。JSONL は既存consumer維持のため据え置く(§4-1参照)。**`agent-audit.ts` は T-todo-3 の対象外だが隣接領域にあるモジュールである旨を、Phase 9C側・T-todo-3側の両ドキュメントへ相互記載する。**

---

## 4. JSONL監査の扱い

JSONLを単一方針では扱わない。§1と同一の判定基準(「主体の権限行使を記録しているか」)で2クラスに分ける。

### 4-1. クラスA: 帰属・権限に関わるJSONL

**agent-audit.ts(submit_agent 委任ログ)**

- Phase 9C で **`audit_events` 側に正本を作る**(`event_kind='delegation.grant'`、`parent_event_id` で委任元リクエストへ接続、`job_id` で被委任実行へ接続)。これにより AUTHZ-INV-009 の双方向追跡が成立する。
- JSONL 側の書き込みは**据え置く**(挙動無変更)。恒久二重管理ではなく、根拠と終了条件を持つ暫定並走とする:
  - 根拠1: 既存consumer `readRecentAgentEvents(days)` が実在し、ローカル専用デプロイでの唯一の読み取り面である。
  - 根拠2: Phase 9C は監査の追加であって既存監査面の除去ではない(既存監査情報を壊して置換しない、という設計姿勢)。
  - 終了条件: `gbrain agent logs` が DB を読むようになった時点で JSONL 書き込みを撤去する。これを bd タスクとして T-todo-3 wave に登録し、Phase 9C 側 docs にも相互記載する。
- `agent-audit.ts` は T-todo-3 の6モジュール一覧には含まれない(TODOS.md:2467確認済み)が、同種のJSONL監査という点で T-todo-3 と隣接領域にあるモジュールである旨を、両ドキュメントに明記する。

**oauth-diagnostic.ts(Unit E-1/E-4 一時診断モジュール)**

- Phase 9C は /authorize・/token・/revoke に対する恒久的な `audit_events` 行を発行する。これにより一時診断モジュールの存在理由(監査ゼロの穴埋め)は消える。
- **ただし Phase 9C ではこのファイルを変更しない(non-goal)**。理由: ChatGPT Connector の「connection failed」調査(Unit E-1/E-4、2026-07-24導入)が進行中の可能性があり、稼働中の調査面をアーキテクチャ変更の副作用で触るべきでない。ハードコードされた個人絶対パス(`/Users/lab/Library/Logs/gbrain-oauth-diagnostic.jsonl`)への書き込みという運用上の負債は事実として認識し、「connector root cause 確定後の撤去または env フラグ化」を独立の bd タスクとして登録する(発見した問題は必ず記録する原則)。

### 4-2. クラスB: 運用診断JSONL(`createAuditWriter` 系モジュール、調査時点で18個以上確認済み)

- rerank / shell / supervisor / slug-fallback / phantom / graph-signals / lease-pressure / backpressure / pool-recovery / batch-retry / self-upgrade / db-disconnect / lock-renewal / content-sanity / schema-pack 系ほか。§2-2 OUT-4・§6 non-goal 9 と同様、対象外の判定はモジュールの個別列挙・正確な総数把握ではなくカテゴリ基準による。正確な総数把握・網羅的listingはT-todo-3側の責務とする。
- いずれも主体なし・認可判定なし・Principal なし。gbrain自身の内部健全性テレメトリ。
- **Phase 9C 対象外。T-todo-3 の所有領域**。`audit_events` へ流し込むと、高頻度テレメトリでセキュリティ監査証跡が埋まり、保持方針・RLS方針・アラート方針が全て両立不能になる。
- ただし T-todo-3 が着地できるよう、Phase 9C は共通プリミティブを提供する: (a) durable spill writer、(b) `audit_write_failures` カウンタと doctor 連携点、(c) 「`event_log` は運用テレメトリ、`audit_events` はセキュリティ証跡」という境界基準の明文化。T-todo-3 は `createAuditWriter` 側からこれらを再利用するだけでよくなる。

---

## 5. Organization/Tenant(Phase 9G)先行の要否

**判定: Organization/Tenant(Phase 9G)を先行させる必要は「ない」。Phase 9C をそのまま進める。**

### 根拠

1. **文書上の依存は一方向**。Phase 9G は Phase 9B〜9F に依存する側であり、Phase 9C が 9G に依存する記述は設計文書に存在しない(Stage 1 調査で確認済み)。逆順を要求する記録もない(ただし当該PHASE9A-GAP-AND-ROADMAP.md §7自体は「Phase 9A時点でのSonnetによる提案であり確定した実装計画ではない」と明記されている。本判定の結論は根拠1単独ではなく、根拠3(決定的な論拠)に独立に支えられている)。
2. **`audit_events` は新規テーブルである**。`organization_id` を後から加える操作は `ALTER TABLE audit_events ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT` + 部分インデックス1本で完結する。これは Phase 9B が `principals` に対して既に採用し、内部・外部レビューを通過した論法とまったく同一であり、新たな前例を作らない。
3. **決定的な論拠 — org帰属は破壊的backfillなしに事後導出できる**。Organization は Principal の集合を束ねる概念であり、org所属は `principal_id` からの join で解決される。Phase 9C が `principal_id` を書き込み時点で確実に取得しておけば、Phase 9G 到来時に過去の監査行の org帰属はクエリ時 join で復元できる。すなわち「今 org 列を持たないこと」による回復不能な情報損失は発生しない。逆に `principal_id` を取り損ねた行は org も永久に不明になるため、優先すべきは 9C であって 9G ではない。
4. **9G を先行させた場合の実害**。テナント境界を定義するには Principal → Organization の写像を決める必要があるが、現時点で帰属済みの実データが存在しない(`oauth_clients.principal_id` は Phase 9B で追加されたばかりで全て NULL)。検証対象のない状態で org モデルを確定させると、後で実データと合わずに作り直す確率が高い。
5. **9G先行は9Cの作業を増やす**。テナント分離RLSを、書き込み経路がまだ統一されていない監査表に対して先に敷くと、9C での書き込み統一時にポリシーの再設計が必要になる。順序として非効率。

### 残リスクと緩和

- リスク: Phase 9C 稼働中に蓄積された監査行に org 列がない。
- 緩和: 根拠3の通り `principal_id` 経由の join で導出可能。加えて Phase 9C の設計文書に「`organization_id` 拡張点」を明記し、**認可コア・監査コアのいずれにも organization 概念に分岐するコードが存在しないこと**をテストで固定する(AUTHZ-INV-015 の予防的適用)。これにより 9G は分岐の追加ではなく列とポリシーの追加で済む。
- 補足: `source_id` をコア列として持つ設計は、gbrain に実在する唯一のデータ境界を監査に残すものであり、Organization/Tenant が来るまでの間の実務的な境界フィルタとして機能する。これは org の先取り実装ではなく、既存概念の記録である。

---

## 6. Non-Goals(Phase 9C対象外・全項目)

以下は Phase 9C の対象外として明確に宣言する。「将来検討」ではなく、対象外であることの確定である(先送りする場合は先送り先のPhaseを明記する)。

1. 改ざん検知(hash chain / 署名 / WORM ストレージ / 外部への追記専用エクスポート)の実装。複数プロセスの並行書き込み下では直列化writerが必要でアーキテクチャ変更を伴い、かつ同一信頼境界内では chain を再計算できるため実効的な改ざん耐性を与えない。gbrain の完全性境界は Postgres のロール権限と RLS とする。
2. `delegation_id` 列および Delegation テーブルの新設(Phase 9E)。1階層の委任チェーンは `event_kind='delegation.grant'` + `parent_event_id` + `job_id` で完全に再構成でき、AUTHZ-INV-009 を満たす。
3. 孫委任(delegation of delegation)の実装・監査(Phase 9E)。現状 submit_agent が `parent_job_id` を渡さず、ツールレジストリに submit_agent 自体がないため技術的に不可能。
4. `organization_id` 列および Organization/Tenant モデル(Phase 9G)。`ALTER TABLE ADD COLUMN` 1本の拡張点としてのみ設計文書に記載する。
5. `execution_instance_id` という独立列の新設。1つのインバウンド要求から複数の `audit_events` 行(例: `authorization.decision` 行 + `operation.request` 行)が生成されうる設計であるため、Execution Instance(1回のリクエスト試行)を表す識別子は既存の `correlation_id`(リクエスト単位)、委任実行の識別子は既存の `job_id`(1ジョブ単位)が担っており、同義の第3の識別子を作らない。
6. `requireAdmin` を `hasScope`/`authorizeOperation` 経由へ統一すること(AUTHZ-INV-010 の是正、Phase 9D)。Phase 9C は管理画面に監査を追加するのみで、認可挙動は一切変更しない。
7. stdio MCP およびローカルCLIの一般操作の監査計装。帰属状態値 `local_process` はシードするが計装は行わない(委任イベントのみ例外的に対象)。
8. /admin/api/* の読み取り専用GET 11ルートの監査。
9. 運用診断JSONLモジュール(rerank / shell / supervisor / slug-fallback / phantom / graph-signals / lease-pressure / backpressure / pool-recovery / batch-retry / self-upgrade / db-disconnect / lock-renewal / content-sanity / schema-pack 系)の DB統合。対象外(OUT)の判定はモジュールの個別列挙・正確な総数把握ではなく、カテゴリ基準(主体も認可判定も存在しない、gbrain自身の内部健全性テレメトリであるかどうか)による。実際の該当モジュール数は調査時点で18個以上確認されており、正確な総数把握はPhase 9Cの設計判断に影響しない(カテゴリ全体が対象外であるため、個別モジュールの漏れがあってもnon-goalの妥当性自体は変わらない)。正確な総数把握・網羅的listingはT-todo-3側の責務とする(T-todo-3 の所有領域、§3参照)。
10. `minion_self_fix_log` の `audit_events` への統合。
11. `mcp_request_log` の物理DROPおよび互換ビューの撤去(退役wave)。
12. `agent-audit.ts` の JSONL 書き込みの撤去。`gbrain agent logs` が DB を読むようになった後に行う(bd タスク登録済み扱い)。
13. `oauth-diagnostic.ts` の削除・envフラグ化・ハードコードパスの是正。進行中の調査面であるため独立タスクとする(発見事項としては記録する)。
14. `oauth_clients` の hard delete(`auth.ts:315`)を soft delete へ統一すること、およびそれに伴う `audit_events.client_id` への FK 追加。
15. `mcp_request_log` の既存行から `audit_events` 行を合成する backfill、および `token_name` 文字列一致による推測FK付与。
16. 歴史的監査行の一括再帰属コマンド(`gbrain audit attribute` 相当)。
17. `backfill_confidence` / `attribution_note` 列の先行実装。
18. 監査行の自動削除(既定有効の retention job)。prune 機構は提供するが既定は無効。
19. `mcp_spend_log` / `mcp_spend_reservations` への RLS 設定(`audit_events` は参照しないため)。
20. `dashboard-feibe` / `dashboard-ikosb`(`verifyAccessToken` のキャッシュ欠如)の解消。Phase 9C は同関数の認証往復回数を増やさない設計とするが、キャッシュ導入自体は別タスク。`credential.verify`(v126でシード済みの `event_kind`)はPhase 9Cでは実際には発行されず、`verifyAccessToken()` には一切の監査計装を追加しない(§2-1参照)。この除外により、`attribution_state='authentication_failed'` は `verifyAccessToken()` 自身のトークン検証失敗(無効・失効・期限切れトークン)には一切書き込まれない(Bearerトークン以外の資格情報検証失敗、例えばwebhook HMAC署名不一致でのみ使用される)。これはAUTHZ-INV-013が求める「欠落は意図的な設計として明示的に文書化される」の要件を満たす意図的な非対象化である。
21. `--log-full-params` フラグの廃止または既定値変更。適用範囲を MCP ツール引数に限定することのみ行う。
22. 監査イベントのグローバルな全順序保証。`occurred_at` + `correlation_id` + `parent_event_id` による再構成のみを保証する。

---

## 7. 2026-08-02にユーザーが確定した4件の決定事項

Stage 2(Opus設計)が `open_questions_for_user` として提示した4件の未決事項について、ユーザーが2026-08-02に以下のとおり確定した。以降の Phase 9C 設計・実装はこの4件を前提として進める。

### (a) Phase 9B実装34ファイルの独立コミット

Stage 1調査時点(2026-08-02)で Phase 9B の実装34ファイルは working tree 上に未コミットのまま Phase 9C の調査が着手されていた(`git status --short` 34件、HEAD `6906ab998201...`)。Opus は「HANDOVER.md が『各Phaseは独立コミット単位』を原則としており、このまま積み重ねるとレビュー単位・ロールバック単位が肥大化する」ことを未決事項として提示した。

**確定**: Phase 9B実装34ファイルは独立コミット済み(commit `fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。Phase 9C はこのコミットを起点として進める。

### (b) `oauth_clients` の hard delete → soft delete 統一は今回実施しない

Opus は「`oauth_clients` の hard delete(`src/commands/auth.ts:315`)を soft delete(`deleted_at` のみ)へ統一すれば `audit_events.client_id` に `ON DELETE RESTRICT` の FK を張れ、Phase 9B の FK 原則と完全に整合する。ただし既存CLIコマンドの意味論変更にあたる」として方針判断を求めた。

**確定**: 今回は実施しない(Opus提案どおり)。`client_id` は FK なしの非正規化列のまま提示された時点の識別子を保持する(§6 non-goal 14)。この hard delete が監査帰属を孤児化する問題は独立の bd タスクとして登録済み扱いとする(soft delete 統一 → その後の FK 追加、という順序で将来対応する)。

### (c) `/admin/api/*` の読み取り専用GET 11ルートは監査対象外のまま

Opus は「コンプライアンス要件として『管理画面での閲覧行為そのもの』を記録する必要があるか。必要なら jobs/watch・health-indicators のような高頻度ポーリング系だけを除外する部分適用に切り替える」として運用要件の判断を求めた。

**確定**: 監査対象外のまま(Opus提案どおり)。§2-2 OUT-3 に記載のとおり、Authority状態を変えない読み取り専用GET 11ルートは Phase 9C の対象に含めない(§6 non-goal 8)。

### (d) `gbrain audit prune` の既定は自動削除なし

Opus は「本番デプロイのDB容量制約から既定で保持期間を設けたい場合、その期間(例: 365日)の指定が必要。監査記録の削除は不可逆であり、既定値の決定はユーザーの明示判断が必要」として確認を求めた。

**確定**: 既定は自動削除なし(Opus提案どおり)。`gbrain audit prune --older-than <days> [--dry-run]` の機構自体は提供するが、既定では自動的に発火しない(§6 non-goal 18)。監査記録の無言削除は増加より有害という判断による。`gbrain doctor` は `audit_events`/`mcp_request_log` の行数・サイズが閾値を超えたら警告するが、削除は強制しない。

---

## 参照元

- Stage 1(現状調査、6エージェント並列): audit-storage / identity-auth / protocol-entrypoint / schema-migration / tests-evidence / prior-design-beads の各findings。
- Stage 2(Opus設計): `scope_boundary` / `jsonl_disposition` / `non_goals` / `org_tenant_precedence` を主に参照。
- `PHASE9C-PREREQUISITES.md`(2026-08-02付、Phase 9B内部レビューを踏まえた前提整理)。
