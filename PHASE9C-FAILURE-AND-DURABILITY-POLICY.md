# Phase 9C — 監査失敗時ポリシー・耐久性機構

**日付**: 2026-08-02
**位置づけ**: Phase 9C(Universal Audit Event Integration)の設計文書の一つ。Stage1現状調査(6エージェント並列、gbrainリポジトリの読み取り専用調査)およびStage2設計(Opus、正式アーキテクチャ設計)の内容を整理・体系化したものであり、本書自体が新しい設計判断を行うものではない。監査書き込み(`audit_events` INSERT)が失敗した場合に「操作自体をどう扱うか」(fail-open/fail-closed)と、「失敗した監査記録をどう失わずに回収するか」(有界リトライ・spill・再送・冪等性・doctor連携)の2点を扱う。実装は行わない。
**関連する既存の問題**: Stage1調査(`audit-storage`担当)は、現行 `mcp_request_log` への INSERT 7箇所(`src/commands/serve-http.ts`)がすべて `try { await executeRawJsonb(...) } catch { /* best effort */ }` で囲まれ、失敗が可視化・リトライ・再送のいずれもされずに無言で消えることを確認済み。本書が定める失敗ポリシーは、この既存ギャップ(黙って消える)を「黙らない」形に置き換えることを主眼とする。

---

## 0. 前提として確定済みの事項(2026-08-02、ユーザー確定)

以下はStage2設計の `open_questions_for_user` に対してユーザーが2026-08-02に回答し確定した事項であり、本書もこれを前提として扱う。

- **(a)** Phase 9B実装34ファイルは独立コミット済み(commit `fcdb7c47d34696a1cb23fb79e878978dc0c23186`)。Phase 9Cはこのコミットの上に積み上げる。
- **(b)** `oauth_clients` のhard delete(`src/commands/auth.ts:315`)をsoft delete(`deleted_at`)へ統一することは今回は実施しない。`audit_events.client_id` は引き続きFKなしの非正規化列として扱う(§2のトランザクション同一性設計・§6の再送設計のいずれもこの前提の上で成立する)。
- **(c)** `/admin/api/*` の読み取り専用GET 11ルートは監査対象外のまま維持する。本書のクラス分類(§1)においてもこれらは対象操作に含めない。
- **(d)** `gbrain audit prune` の既定は自動削除なし。§6-6で詳細を扱う。

---

## 1. 操作種別の4クラス分類

監査失敗時にどう振る舞うかは、ポリシーとして個別に決めるのではなく、**操作が Authority 状態を変えるかどうか**という単一の基準で4クラスに分類し、クラスごとに機構を割り当てる。

| クラス | 対象操作 | 機構 |
|---|---|---|
| **クラス1**: Authority状態変更 | **発行系**(権限を新規に付与する操作): `/token`(発行)、`/authorize`のコード発行、api-keys発行(POST)、register-client、update-client-ttl、issue-magic-link、POST /admin/login、GET /admin/auth/:token、`submit_agent`の委任grant<br>**失効系**(権限を剥奪・失効する操作): `/revoke`、api-keys/revoke、revoke-client、sign-out-everywhere | **発行系**: fail-closed。機構の主体はポリシー分岐ではなく**トランザクション同一性**(§2-1〜2-3)。<br>**失効系**: 監査基盤障害時の実害(侵害対応・緊急ロックアウトの実効性喪失)を避けるため、例外的に**fail-open**(§2-4)。 |
| **クラス2**: 認可拒否・認証失敗 | insufficient_scope、unknown_operation、Bearerトークン以外の資格情報検証失敗(例: webhook HMAC署名不一致)、`/ingest`のバリデーション拒否、`submit_agent`の委任拒否 | **degraded-durable**。拒否レスポンスは監査の成否によらず必ず返す(§3)。 |
| **クラス3**: 通常の成功データ操作 | `tools/list`、`tools/call`の成功、`/ingest`成功、webhook受理 | **fail-open + durable spill + アラート**(§4)。 |
| **クラス4**: system_internalイベント | gbrain自身が外部主体なしに発行するイベント(スケジュールされたworker、self-fix、retention job等) | **fail-open**。ただしspill対象(§5)。 |

クラス2の`attribution_state='authentication_failed'`は、Phase 9Cが新規に計装する経路のうち`verifyAccessToken()`以外の資格情報検証失敗(例: `POST /webhooks/github`のHMAC署名不一致)で使用される。`verifyAccessToken()`自体が判定するBearerトークンの検証失敗(無効・失効・期限切れトークン)は、Phase 9Cでは一切監査計装されない。これは新しい除外ではなく、既存のnon-goal#20(`verifyAccessToken()`への計装追加を明示的に非対象とする、最高頻度パスの往復回数を増やさないため)の直接の帰結である。

クラス3(通常の成功データ操作)には、`tools/list`・`tools/call`の成功に加え、認可は通過したが実行自体が失敗したケース(`dispatchToolCall`内の例外、`toolResult.isError=true`、`/ingest`のキュー投入失敗等、decision=allowed・outcome=failed)も含む。これらはAuthority状態を変更しないため、クラス1(fail-closed)ではなくクラス3(fail-open)として扱う——現行のcatch{}によるbest-effort(常にレスポンスを返す)という既存挙動を後退させないため。

全操作を一律fail-closedにするとgbrainが使用不能になり、全操作を一律fail-openにすると監査の欠落が黙認される。この二値を避けるための分類がこの表である。

---

## 2. クラス1: Authority状態変更 — 発行系はfail-closed(主機構はトランザクション同一性)、失効系は例外的にfail-open(§2-4)

クラス1は「発行系」(権限を新規に付与する操作: `/token`発行、`/authorize`のコード発行、api-keys発行(POST)、register-client、update-client-ttl、issue-magic-link、POST /admin/login、GET /admin/auth/:token、`submit_agent`の委任grant)と「失効系」(権限を剥奪・無効化する操作: `/revoke`、api-keys/revoke、revoke-client、sign-out-everywhere)を区別する。発行系は従来どおりfail-closed(監査成功を前提条件とし、監査失敗時は発行自体を行わない——発行をブロックすることは安全側)を維持する(§2-1〜2-3)。失効系は、監査基盤の障害によって失効操作自体がブロックされることの実害(侵害対応・緊急ロックアウトの実効性喪失)が、「未監査のまま失効される」ことより大きいため、例外的にfail-openとする(§2-4)。

### 2-1. 発行系の主機構: トランザクション同一性

状態変更がDB書き込みを伴う場合(api-keys発行、`oauth_clients`更新、`oauth_tokens`発行等)、**監査行のINSERTを状態変更と同一トランザクションに入れる**。

`engine.transaction<T>()`インターフェース自体はPostgresEngine/PGLiteEngine双方に実装済みである。クラス1発行系の対象コード経路は、DB書き込みを伴うかどうかで本節(トランザクション同一性)と§2-2(インメモリ状態変更)のいずれの機構に従うかが分かれる。DB書き込みを伴う経路(api-keys発行(POST)、register-client、update-client-ttl、oauth-provider.tsのトークン発行、submit_agentの委任grant)は、いずれも現状engine.transaction()を使わない非トランザクションの単発SQL実行(モジュール/インスタンス生成時に固定されたSQLハンドル)になっている。したがって「監査INSERTを状態変更と同一トランザクションに入れる」ことを実現するには、これら該当コード経路をengine.transaction()呼び出しへリファクタリングする実装作業がStage5で必要になる(既存の抽象化を呼ぶだけで済む軽微な変更ではない)。この作業はPhase 9Cの実装スコープに含まれる(失効系は§2-4のとおりfail-open+spillで扱うため、この engine.transaction() リファクタリング対象には含まれない)。一方、issue-magic-link・POST /admin/login・GET /admin/auth/:tokenの3ルートは、DB書き込みを一切伴わない(実コード確認済み: `src/commands/serve-http.ts`のこの3ハンドラはいずれもSQLを発行せず、`magicLinkNonces`・`adminSessions`というインメモリMapへの操作のみで完結する)ため、本節(トランザクション同一性)の対象ではなく、§2-2の逐次機構に従う。

この設計により、以下の2つの不整合が原理的に発生しなくなる。

- 「状態は変更されたが、監査行が記録されていない」
- 「監査行は記録されたが、状態は変更されていない」

これは「監査が失敗したら状態変更を拒否する」というポリシー判断ではなく、**同一トランザクションのコミット/ロールバックという原子性**で解決する。監査INSERTが失敗すればトランザクション全体がロールバックされ、状態変更自体も発生しない。

### 2-2. 発行系の副次機構: インメモリ状態変更の場合

状態変更がDB書き込みを伴わない場合(例: `adminSessions` はインメモリの `Map<string, number>`)、トランザクション同一性は使えない。この場合は以下の順で処理する。**状態変更は監査成功を前提条件とし、状態変更が監査より先に起きることは決してない。**

1. 監査INSERTを試みる。
2. 失敗した場合はspill(§6-3、DB INSERT失敗を検知した時点で即座に同期的に書き込む)への書き込みを試みる。
3. 監査INSERTまたはspillのいずれかが成功して初めて、実際のインメモリ状態変更(例: `adminSessions.set(...)`)を実行する。
4. 監査INSERT・spillの両方が失敗した場合、状態変更は一切実行せず、503を返す(運用者に可視なエラーとしてカウンタ増分、§6-5)。

### 2-3. 発行系の安全側の性質

fail-closedが「余分な権限を与える」方向に働くことは構造上ない。

- 資格情報の発行に失敗すれば、資格情報そのものが発行されない(危険側に倒れない)。

失効(revoke)系の安全側の性質は§2-4で扱う(発行系とは異なりトランザクション同一性ではなくfail-openで担保する)。

### 2-4. 失効系: 例外的にfail-open

対象: `/revoke`、api-keys/revoke、revoke-client、sign-out-everywhere。

監査基盤の障害によって失効操作自体がブロックされることの実害(侵害対応・緊急ロックアウトの実効性喪失)は、「未監査のまま失効される」ことの実害より大きい。そのためクラス1の中で失効系のみ例外的にfail-openとする。

- 状態変更(失効)は監査の成否に関わらず必ず実行する(発行系のようにトランザクション同一性で監査成功を前提条件にしない)。
- 監査INSERT失敗時は、クラス3と同様に即座に同期的にspillへフォールバックし(§6-3)、`audit_write_failures_total`を増分する(§6-5)。
- ただし失効操作の監査記録欠落はセキュリティ上重要度が高いため、通常のspillに加えて`audit-critical-failures.log`へも必ず書き込み、`gbrain doctor`の優先度の高い警告対象とする(§6-5)。

### 2-5. リトライ方針(発行系)

一時的障害(接続断、シリアライズ失敗)に限り、§6-1で定める有界リトライ(2回、25ms/100msバックオフ。クラス1のうち発行系に固有の機構であり、失効系およびクラス2〜4には適用されない)を適用する。制約違反(PostgreSQLエラーコード23xxx、例: FK違反・CHECK違反)は再試行の対象にしない — これは一時障害ではなく実装上の欠陥シグナルであり、リトライしても解消しないため。失効系は§2-4のとおりリトライせず即座にspillへフォールバックする。

---

## 3. クラス2: 認可拒否・認証失敗 — degraded-durable

対象: insufficient_scope、unknown_operation、Bearerトークン以外の資格情報検証失敗(例: webhook HMAC署名不一致)、`/ingest`のバリデーション拒否、`submit_agent`の委任拒否。

`verifyAccessToken()`自身が判定するBearerトークンの検証失敗(無効・失効・期限切れトークン)はクラス2の対象に含まない。これはnon-goal#20(`verifyAccessToken()`への計装追加を非対象とする)の直接の帰結であり、Phase 9Cでは一切監査計装されない。

### 3-1. 手順

1. 監査行のDB INSERTを試みる。
2. 失敗したら即座に同期的にspillへの書き込みを試みる(§6-3)。
3. spillも失敗したら stderr へ出力し、カウンタ(§6-5)を増分する。クラス3・4・クラス1失効系(§4・§5・§2-4)と同様、この二重障害(DB書き込み失敗+spill失敗)の場合は`audit-critical-failures.log`へも書き込む。

### 3-2. 原則(絶対遵守)

- **拒否レスポンスは、監査の成否によらず必ずそのまま返す。**
- **監査行が書けないことを理由に、拒否の判定を保留したり、レスポンスを5xxへ変換したりしない。**

理由: 拒否は「何も権限が付与されていない」状態への応答であり、監査が書けなくても呼び出し元が同じリクエストを再試行するだけで、fail-closedにする利益(=余分な権限行使を止める効果)が存在しない。拒否を5xxへ変換すると、呼び出し元は「サーバ側の一時的な問題」と誤認してリトライを繰り返すだけになり、実害なく可用性のみを損なう。

### 3-3. 監査が書けなかった事実の扱い

「拒否は返すが監査は書けなかった」という状態を握りつぶさない。カウンタ増分・spillへの記録・doctorでの検知(§6-5)を通じて、この状態自体が運用上可視になるようにする。

---

## 4. クラス3: 通常の成功データ操作 — fail-open + durable spill + アラート

対象: `tools/list`、`tools/call` の成功、`/ingest` 成功、webhook受理。加えて、認可は通過したが実行自体が失敗したケース(`dispatchToolCall`内の例外、`toolResult.isError=true`、`/ingest`のキュー投入失敗等、decision=allowed・outcome=failed)もクラス3に含む(§1参照)。

- **fail-open**: 監査行が書けなくてもgbrainは動作を継続する(呼び出し元の成功レスポンスをブロックしない)。
- **ただしsilentにはしない**: 監査INSERTが失敗した場合は必ず即座に同期的にspillへ落とし(§6-3)、カウンタを増分し(§6-5)、doctorが検知できる状態にする。
- **最終フォールバック**: spill自体の書き込みが失敗した場合(ディスク満杯・パーミッション不備等)は、stderrへ出力し、カウンタ(audit_write_failures_total)を増分する。この場合も無言のcatch{}で握りつぶすことはしない。加えて、spillへの書き込み自体が失敗した場合は、専用の最小フォーマットマーカーファイル(`audit-critical-failures.log`、追記のみ、タイムスタンプと簡潔な理由のみを記録)への書き込みを試みる。`gbrain doctor` はこのファイルの存在・非空も追加の非ゼロ終了条件とする。spillと同じディスクへの書き込みであるため、真のディスク満杯時はこの二重防御も失敗しうるが、それ以外の失敗モード(パーミッション不備・パス不整合等)については、この機構により二重障害(DB書き込み失敗+spill失敗)もdoctorから検知可能になる。

現行の `mcp_request_log` 書き込みが持つ `catch { /* best effort */ }`(7箇所、`src/commands/serve-http.ts`)との違いは、**fail-openにするかどうか自体ではなく「黙るか黙らないか」**である。現行実装は失敗を完全に握りつぶすため、監査の欠落自体が検知不能になっている。ここを解消することが、本書が定める失敗ポリシーの実質的な品質向上点である。

---

## 5. クラス4: system_internalイベント

対象: gbrain自身が外部主体の関与なしに発行するイベント(スケジュールされたworker、self-fix、retention job等)。

- fail-open。gbrain内部の意思決定を記録するイベントのために、外部からの要求を落とすことはしない。
- クラス3と同様、監査INSERTが失敗した場合は即座に同期的にspill対象とする(§6-3)。gbrain自身の内部イベントであっても、失敗を握りつぶさない原則は変わらない。
- **最終フォールバック**: spill自体の書き込みが失敗した場合(ディスク満杯・パーミッション不備等)は、stderrへ出力し、カウンタ(audit_write_failures_total)を増分する。この場合も無言のcatch{}で握りつぶすことはしない。加えて、spillへの書き込み自体が失敗した場合は、専用の最小フォーマットマーカーファイル(`audit-critical-failures.log`、追記のみ、タイムスタンプと簡潔な理由のみを記録)への書き込みを試みる。`gbrain doctor` はこのファイルの存在・非空も追加の非ゼロ終了条件とする。spillと同じディスクへの書き込みであるため、真のディスク満杯時はこの二重防御も失敗しうるが、それ以外の失敗モード(パーミッション不備・パス不整合等)については、この機構により二重障害(DB書き込み失敗+spill失敗)もdoctorから検知可能になる。

---

## 6. 共通機構

クラス1〜4を横断して使用する耐久性機構。以下はすべて `audit_events` 専用に実装するが、T-todo-3(既存の15以上の運用診断JSONLモジュールをDBへ寄せる別ウェーブの計画)が同じプリミティブを再利用できるよう設計する。

### 6-1. 有界リトライ

この有界リトライ(SAVEPOINTベースの再試行)は**クラス1のうち発行系(Authority状態変更、トランザクション同一性)に固有の機構**である。クラス1の失効系(§2-4)およびクラス2〜4は、DB INSERTの初回試行が失敗した時点でリトライせず、即座に同期的にspillへフォールバックする(§2-2/§2-4/§3-1/§4/§5の「即座に同期的にspill」という記述のとおり)。

- 一時的障害(接続断、シリアライズ失敗)のみを対象に、**最大2回**、**25ms → 100ms** のバックオフで再試行する。
- 制約違反(PostgreSQLエラーコード23xxx: FK違反・CHECK違反・UNIQUE違反等)は再試行の対象にしない。これは一時障害ではなく欠陥シグナルとして扱う(§7参照)。
- クラス1発行系のリトライは、監査INSERT文の直前でSAVEPOINTを発行し、監査INSERT失敗時はROLLBACK TO SAVEPOINTしてから監査INSERTのみを再試行する(トランザクション全体やそれ以前の状態変更文は再実行しない)。これによりPostgreSQLのトランザクション中断セマンティクス(1文のエラーでトランザクション全体がaborted状態になる)を回避しつつ、状態変更文自体を非冪等な形で再実行するリスクを避ける。
- 監査INSERTのタイムアウトは、クラスごとに差別化した値を明示的に設定する。既定のセッションレベル`statement_timeout`(5分)には依存しない。
  - **クラス2・3・4(fail-open・リトライなし。`/mcp`・`/mcp-v2`の最高頻度パスを含む)**: 通常のMCPツール呼び出しレイテンシ(数十〜数百ms)のスケールに合わせ、短いタイムアウト約300msを設定する。タイムアウトしたら即座に同期的にspillへフォールバックする。
  - **クラス1発行系(SAVEPOINTベース有界リトライ、最大2回・25ms/100msバックオフ)**: 1回あたり約2秒のタイムアウトを許容する。これは既に稀な同期的grant操作であり、速度よりfail-closedの安全性を優先するためである。最悪合計待ち時間はタイムアウト×3試行+バックオフ≒6.1秒となる。
  - **クラス1失効系(§2-4、例外的fail-open)**: 失効操作は常に迅速に完了させるべきであるため、クラス2・3・4と同じ約300msの短いタイムアウトとする。
  - いずれのクラスでも、DBが完全ダウンではなく応答が遅いだけの状態(ロック競合・プーラー詰まり等)で監査INSERTが長時間ブロックし続けることを避け、fail-open(§4・§5)が「呼び出し元の成功レスポンスをブロックしない」という保証を、実際の劣化DBシナリオ下でも維持する。

### 6-2. 有界メモリリング(同時実行キャップ)

- 「有界メモリリング」は、監査行を長時間保持する耐久性バッファではない。DB INSERTが失敗した監査行は、その場で(呼び出しを完了する前に)同期的かつ即座にspillファイル(§6-3)へ書き込まれる——リングに滞留させて後でまとめてspillする設計ではない。
- リング(上限1000)の役割は、同時並行して進行中の書き込み試行・リトライ処理の数を制限する**同時実行キャップ**であり、行そのものを蓄積する場所ではない。
- この設計により、プロセスクラッシュ時に消失しうるのは「クラッシュの瞬間に実行中だった書き込み試行」の範囲(同時実行キャップの定義上、上限1000件)に限定され、spill済みの行は消失しない。

### 6-3. spill形式

- 監査行は、DB INSERT失敗を検知した時点で(§6-2のリングに滞留させて後でまとめて書き出すのではなく)同期的に即座にspillへ書き込まれる。
- 既存の `createAuditWriter` プリミティブ(`src/core/audit/audit-writer.ts`)を再利用し、監査行を完全な envelope(UUIDの `id` を含む)としてJSONL形式でファイルへ書き出す。
- ファイル名: `audit-spill-YYYY-Www.jsonl`(ISO週番号ベース、週次ローテーション)。
- spillファイル(`audit-spill-YYYY-Www.jsonl`)の書き込みは、gbrainの既存セキュリティ慣行(`oauth-diagnostic.ts`・`ingress-diagnostic.ts`が採用する `{mode: 0o600}`)に倣い、ファイル作成時に mode `0o600` を明示的に指定する。既存の `createAuditWriter()` プリミティブがこのmode指定を持たない場合、Writer実装時にmode指定を追加する(または `createAuditWriter()` 自体にmodeオプションを追加する)。spillファイルには actor_label・redaction後の error_message・マスク済みIP・credential_ref(ハッシュ先頭16文字)等、DB到達後はRLSで保護されるはずの情報が含まれるため、この権限設定は必須とする。
- プロセス終了時には、リング上で処理中(書き込み試行がまだ完了していない)の監査行をspillへフラッシュしてから終了する。
- spill書き込みは非ブロッキングI/O(`fs.promises.appendFile`、またはメインイベントループをブロックしない専用の書き込みキュー)を用いる。既存の `createAuditWriter()` が同期I/O(`fs.appendFileSync`)を用いている場合、audit spill専用に非同期版を新設するか、既存プリミティブ自体を非同期化する(既存の他の呼び出し元への影響を検討した上で)。これはfail-open(クラス3/4)が「呼び出し元の成功レスポンスをブロックしない」という保証を、DB接続断+高トラフィックという実際に想定される障害シナリオ下でも維持するために必須の設計要件である。

### 6-4. 再送と重複排除(`gbrain audit replay-spill`)

- spillされた行の再投入は `gbrain audit replay-spill` コマンドが担う唯一の正規手段とする。
- 再投入は `INSERT ... ON CONFLICT (id) DO NOTHING` で行う。
- 冪等性が成立する理由: `audit_events.id` は `SERIAL` ではなく **UUID** であり、DB書き込み以前・アプリケーション側の発生時点(occurred_at と同時)で確定させる。これにより、spillされた行とDBへ最終的に着地する行が同一の `id` を持つことが保証され、同じ行を複数回再送しても二重に記録されない。SERIAL採用時にはこの同一性を再送時に表現できず、冪等な再送が実装できない。
- replay-spillは、spillファイル内の全行が再投入成功(`ON CONFLICT DO NOTHING`)または後述の破損行隔離のいずれかで説明済みになった場合にのみ、そのファイルを処理済みとしてリネーム(例: `.replayed` サフィックス付与)またはアーカイブディレクトリへ移動する。JSON解析に失敗した行を無言でスキップしてファイルを「処理済み」とマークすることは禁止する(1行でも無言で失われることを許さない)。`audit_spill_pending`(§6-5)は、未処理(処理済みマークが付いていない)のspillファイルの行数のみを対象とする。これにより、replay完了後は `audit_spill_pending` がゼロに戻り、`gbrain doctor` も正常(ゼロ終了)に復帰する。
- JSON解析に失敗した行が見つかった場合: (1)破損した生の行を別の隔離ファイル `audit-spill-corrupt.jsonl`(追記、mode `0o600`。§6-3のspillファイルと同じ権限設定)へそのまま書き込む、(2)`audit_spill_corrupt_count`カウンタを増分してログへ出力する、(3)残りの正常な行の処理は継続する(バッチ全体を中断しない)。
- `gbrain doctor` は、`audit-spill-corrupt.jsonl` が非空であることも検知対象に追加する(既存の `audit_spill_pending`・`audit-critical-failures.log` に加える3つ目の指標。§6-5参照)。
- 既存の `createAuditWriter()` の `readRecent()` が持つ無言スキップ実装は、その本来の用途(運用トレース情報)では変更しない。Phase 9Cのspill/replay機構はこの読み取りパスを流用せず、上記の独自実装を用いる。
- replay-spillは、対象ファイルをまずrename(mv)してから内容を読み込む(read-then-renameではなくrename-then-read)。renameはPOSIX上ほぼ原子的な操作であり、rename直後に他プロセスが元のファイル名で新規appendを試みた場合、そのプロセスはファイルが存在しないため新規ファイルとして作成し直す(fs.appendFileSyncのデフォルト挙動)。これにより、rename前にflushされた内容とrename後の新規書き込みが同一ファイル内で混在することを防ぎ、取りこぼしが構造的に発生しない設計にする。

### 6-5. doctorとの連携(アラート)

- `audit_write_failures_total`は、それを計測するプロセス(通常はHTTPサーバプロセス)のメモリ内でのみ有効な値であり、プロセス境界を越えて共有されない。`gbrain doctor` は別プロセスとして起動されるため、このカウンタを直接参照できない。したがって:
  1. `audit_write_failures_total` は `/admin/api/health-indicators`(HTTPサーバプロセス自身が応答するエンドポイント)経由でのみ公開する。
  2. `gbrain doctor` が参照する「欠落の検知可能性」の指標は `audit_spill_pending`(§6-4の通り、未処理=処理済みマークが付いていないspillファイルの行数のみ。ファイルベースであり、プロセス境界に依存しない)、二重障害(DB書き込み失敗+spill失敗)検知用のマーカーファイル `audit-critical-failures.log`(§4・§5参照)の存在・非空チェック、および破損行隔離ファイル `audit-spill-corrupt.jsonl`(§6-4参照)の存在・非空チェックの3つとする。クラス1失効系(§2-4)は例外的に、二重障害を待たず監査INSERT失敗の時点(spill自体は成功していても)で`audit-critical-failures.log`へ書き込む——失効操作の監査記録欠落はセキュリティ上の重要度が高く、`doctor`の優先度の高い警告対象とするため。
- **未処理のspillファイルが非空、`audit-critical-failures.log` が非空、または `audit-spill-corrupt.jsonl` が非空であれば `gbrain doctor` は非ゼロ終了する。** これが「監査の欠落は明示的に検知可能でなければならない」という要求への具体的な充足手段であり、この既存の合格基準は `audit_spill_pending`・`audit-critical-failures.log`・`audit-spill-corrupt.jsonl` の3つに基づく。replay-spillにより該当spillファイルが処理済みとしてマークされれば、`doctor` は正常(ゼロ終了)に復帰する(§6-4)。
- `attribution_unavailable`(帰属状態モデル上、書き込み時点で帰属情報が欠落した行を示す状態)の発生も監視対象とする。この状態は正常状態ではなく欠陥シグナルであり、該当行が発生した場合は `doctor` が警告する。

### 6-6. 保持期間(`gbrain audit prune`、既定は自動削除なし)

- `gbrain audit prune --older-than <days> [--dry-run]` を提供する。
- **既定では自動削除しない**(2026-08-02ユーザー確定、前提§0-(d))。監査記録の無言削除は、記録が無制限に増加することより有害であるという判断による。既存の `op_checkpoints` の7日自動パージ(`purgeStaleCheckpoints`)とは、対象データの性質(運用チェックポイント vs セキュリティ監査証跡)が異なるため、同じ既定値(自動削除あり)を踏襲しない。
- `doctor` は `audit_events` および凍結後の `mcp_request_log` の行数・サイズが閾値を超えた場合に警告する。増加を放置はしないが、削除は強制しない。

### 6-7. 順序保証について

- **グローバルな全順序は保証しない。** 複数プロセス(HTTPサーバ・worker・CLI)からの並行書き込みに加え、spill再送のタイミングが不定であるため、`recorded_at` の単純な昇順が発生順序と一致する保証は原理的に作れない。
- 事象の再構成は `occurred_at`(発生時点のタイムスタンプ)・`correlation_id`(1インバウンド要求に紐づく複数イベントの束ね)・`parent_event_id`(委任チェーンの親子関係)の3つの手がかりで行う。
- 「保証できないものを保証すると書かない」という原則に基づき、全順序保証は明示的に対象外とする。

### 6-8. オフライン・デプロイ形態による差異

- PGLiteによるローカルデプロイでは、DBが常にアプリケーションプロセスと同一ホスト上にあるため、spillが発動する場面はほぼ発生しない。
- リモートHTTPデプロイにおけるDB接続断が、spillが実際に発動する主要な条件になる。

### 6-9. 改ざん検知は対象外(欠落検知とは別軸)

- 本書が担保するのは**欠落の検知**である(§6-5)。ハッシュチェーン・署名・WORMストレージ等による**改ざん検知**は対象外とする(Phase 9C全体のnon-goal)。
- 理由: gbrainはserver・worker・CLIの複数プロセスが同一の `audit_events` へ並行書き込みするため、ハッシュチェーンには直列化Writerが必要でありアーキテクチャ変更を伴う。かつDBへ書き込める主体はチェーン自体を再計算できるため、同一の信頼境界内では改ざん耐性を実効的に提供しない。gbrainの完全性境界はPostgresのロール権限とRLSであり、監査機構自体に改ざん耐性を持たせることはしない。

---

## 7. 明示的に禁止する実装とテストによる担保

### 7-1. 禁止事項

1. **無言の `catch {}` による握りつぶし。** Writer内部(§6の有界リトライ・spill機構そのもの)以外の箇所で監査例外を捕捉して何もしないコードは書かない。
2. **監査失敗を理由に権限を緩める方向の分岐。** 「ログが書けないので許可する」という分岐は、どのクラスにおいても絶対に書かない。fail-open(§4・§5)は「拒否を許可に変える」ことでは決してなく、「記録なしで、通常どおりの判定結果をそのまま返す」ことである。この一文は設計文書だけでなく、実装時にコードコメントとしても明記する。

### 7-2. テストによる担保

- **`test/authorization-invariant-matrix.test.ts` の拡張**(既存ファイルへ追加、新規ファイルは作らない):
  - 同一のscope集合・異なる `attribution_state`(帰属状態モデルのうち`authorizeOperation()`経路に実際に到達しうる9状態。`admin_session`・`unmigrated_legacy_record`は構造的分離自体で担保されるため対象外——`PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md`§6参照)で同一操作を実行し、認可結果が完全に一致することを検証する。
  - grepベースの静的検証: grep対象は `src/core/scope.ts`・`src/core/operations.ts` に加え、`src/commands/serve-http.ts` 内の `requireAdmin` 関数本体、および同ファイル内でPhase 9Cが新設する監査計装コードも含める。`requireAdmin` は `hasScope`/`authorizeOperation` を一切呼び出さない、`scope.ts`/`operations.ts` とは構造的に別の認可平面であるため、両方を独立に検証しなければadmin平面へのPrincipal情報混入を検知できない。これらの認可判定パスに `audit_events` / `attribution_state` / `principal_id` / `channel_id` のいずれの参照も現れないことを機械的に確認する。
  - 監査書き込みが失敗した状態でも認可結果が変わらないことを直接検証する — すなわちfail-openが「許可へ倒れる」方向には絶対に動かないことの直接証明。
- **`test/audit-failure-policy.test.ts`**(新規、失敗を注入するエンジンスタブを使用):
  - クラス1(発行系): 監査INSERTが失敗したとき、状態変更自体がロールバックされ200が返らないこと。
  - クラス1(失効系): 監査INSERTが失敗しても失効の状態変更は必ず実行されること、spillへのフォールバックと`audit-critical-failures.log`への書き込みが行われること。
  - クラス2: 監査が書けなくても拒否レスポンスはそのまま返り、5xxへ変換されないこと。
  - クラス3: fail-openするが、spillファイルが生成されカウンタが増えること。
  - `gbrain audit replay-spill` が同一UUIDを二重投入しないこと(`ON CONFLICT (id) DO NOTHING` の冪等性)。
  - 未処理のspillが非空のとき `gbrain doctor` が非ゼロ終了すること、および `replay-spill` 実行後(該当ファイルが処理済みとしてマークされた後)は `audit_spill_pending` がゼロに戻り `doctor` も正常終了に復帰すること(§6-4)。
  - `replay-spill` がJSON解析に失敗した行を無言でスキップせず、`audit-spill-corrupt.jsonl` へ隔離しつつ残りの正常な行の処理を継続すること、および隔離行が残っている限り元のspillファイルが処理済みとしてマークされないこと(§6-4)。`audit-spill-corrupt.jsonl` が非空のとき `gbrain doctor` が非ゼロ終了すること(§6-5)。
- **catch{} 握りつぶし禁止の機械的強制**: Writer実装ファイル以外での監査例外捕捉を lint / grep ベースのテストで検出し、新規に無言のcatchが追加された場合にCIで検知できるようにする。

これらのテストにより、「監査を強化する変更が既存の認可挙動を意図せず変えてしまう」ことと、「監査失敗時の振る舞いがクラスごとの定義から逸脱する」ことの両方を、レビュー依存ではなく機械的に検出できる状態にする。
