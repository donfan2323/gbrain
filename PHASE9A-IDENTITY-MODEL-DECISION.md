# Phase 9A — Identityモデル確定(Principal/Subject/Client/Credential/Session/Execution Instance/Delegation/Capability/Policy Decision/Audit Event)

**日付**: 2026-08-01
**位置づけ**: `PHASE9A-TARGET-DOMAIN-MODEL.md`で曖昧だったPrincipalとSubjectの境界を確定する。本書は設計判断の記録であり、実装コードそのものではない。抽象化を増やすこと自体を目的とせず、各概念について「本当に分ける必要があるか」を`PHASE9A-SUPPLEMENTAL-AUDIT.md`で確認した実コードの事実に照らして検証した。

---

## 0. 結論(先出し)

**PrincipalとSubjectは分離しない。統合する。** 理由は§2-2で詳述するが、要約すると: gbrainには「1つのワイヤー識別子(client_id)が複数の主体を代表する」という現実の必要性が確認できず、SubjectをPrincipalと別に持つと、Client(既存の`oauth_clients`)と実質的に3つの類似概念が並立してしまい、ユーザー自身が禁止した「抽象化を増やすこと自体が目的化する」状態になる。代わりに、**Principal(新概念)とClient(既存`oauth_clients`)の2層構造**とし、両者を`principal_id`という1本の任意(nullable)リンクで結ぶ。「Subject」という語は、外部仕様(OAuth/JWT文脈)で使われた場合の対応語として本書で言及するに留め、gbrain内部の独立した永続概念にはしない。

Session・Execution Instanceについても、新規テーブルは作らない。Sessionは既存の`oauth_tokens`/`adminSessions`が既に体現しており、Execution Instanceは既存の`mcp_request_log.id`/`minion_jobs.id`が既に体現している。Phase 9Bで新規に必要なのは「これらを概念として明示的に名指しし、Principalへの参照を追加すること」であり、大規模な新規テーブル群の追加ではない。

---

## 1. 各概念の確定

### 1-1. Principal

- **一文定義**: 権限・責任の帰属先となる、システム外部の実在(人間・サービス・自律エージェント・デバイス)、またはその状態が未確定であることを示す最上位の識別対象。
- **責務**: Client・Credential・Delegationが最終的に「誰の権限か」を遡って辿り着く終点を提供する。
- **一意性**: 1レコード=1つの実在(または1つの「未確認」状態)。
- **ライフサイクル**: 作成(登録)→有効→失効(revoked)。削除はしない(監査参照が残るため論理失効のみ)。
- **誰が作成するか**: 管理画面操作者(bootstrap token保有者)、または将来的な自己登録フロー(Phase 9B範囲外)。
- **誰が失効させるか**: 管理画面操作者のみ(Phase 9B時点)。
- **他概念との多重度**: 1 Principal : 多 Client(下記1-3参照)。1 Principal : 多 Credential(将来、Principal自身がCredentialを持つ場合。Phase 9Bでは管理画面bootstrap tokenのみがこれに該当)。
- **認証時に確定するか**: 確定しないことがある。Client認証(OAuth)は成立しても、そのClientにPrincipalがリンクされていなければPrincipalは「未確定(unknown)」のまま。
- **認可時に使用されるか**: 補助情報としてのみ(§3のAUTHZ-INV-001参照)。Principal種別だけでCapabilityは決定されない。
- **監査時に記録されるか**: 記録される(Audit EventはPrincipal未確定でも記録可能。その場合は「principal_id = null」として記録)。
- **現行gbrainの対応物**: 存在しない。最も近いのは「bootstrap tokenを保有する人間」という暗黙の前提。
- **必要性**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`で確認した通り、Phase 8で実際にClaude Code・Codex・ChatGPT connectorという**複数のoauth_clientsが同一人物によって登録・使用されている**。今日「この人が今週何をしたか」を横断的に問うことはできない。Principal概念はこの実在するギャップを埋める。
- **DB永続化の要否**: 必須(監査・グルーピングの基盤となるため実行時表現だけでは不十分)。
- **Phase 9Bで実装するか**: **する**(最小実装、下記§4参照)。

### 1-1a. Principal種別の保存方式(確定)

Principalの種別(human/service/agent/device/unknown等)をどう保存するか、以下4案を比較した。

| 案 | 内容 | 未知種別追加時のスキーマ変更 | 不正値/タイプミス耐性 | 認可分岐への悪用防止 | 監査・表示の利便性 | 後方互換性 | 実装量 | open-world方針との整合性 |
|---|---|---|---|---|---|---|---|---|
| A. 固定CHECK制約 | `type`列に`CHECK (type IN ('human','service','agent','device','unknown'))` | **要**(新種別追加のたびにALTER TABLE) | 強 | コード運用ルールに依存(DB制約自体は無関係) | 良好 | 良好 | 最小 | **矛盾**(閉じた世界を決め打ち) |
| B. 制約なし自由文字列 | `type TEXT`(制約なし) | 不要 | **弱**(表記ゆれ・タイプミスが無制限に混入) | 同上、かつ自由記述ゆえ場当たり値が混入しやすい | 表記ゆれで集計が壊れやすい | 良好 | 最小 | 形式的には開いているが無秩序 |
| C. 登録テーブル参照 | `principal_kinds`テーブル(id/label/description)への外部キー | 不要(データ行のINSERTのみ) | 強(FK参照整合性) | 同上、かつ値の集合が可視化・管理される | 良好(登録済み種別一覧を表示可能) | 良好 | 小(テーブル1つ追加のみ) | **良好**(開いていて秩序がある) |
| D. 安定大分類+拡張属性 | 大分類(例: attributed/unattributed)を固定し、詳細ラベルは別途自由記述 | 大分類は不要変更、詳細ラベルも不要変更 | 大分類は強、詳細ラベルは弱(実害は表示専用のため小) | 同上 | 良好 | 良好 | 中(2列体系+運用ルール) | 良好 |

**決定: C(`principal_kinds`登録テーブル参照)を採用する。**

**理由**: Phase 9の目的である「未知の新しい主体種別を扱える」「新しい主体種別追加時に認可コアやデータモデルを書き換えない」を、Aは真っ向から満たせない(CHECK制約はスキーマ変更なしに新種別を追加できない)。Bは要件を満たすが、タイプミス・表記ゆれに対する保護が皆無で、監査・表示の品質を損なう。Dは合理的だが、Cで既に同等以上の利益(スキーマ変更不要+参照整合性)を、より小さい概念数(2列体系ではなく1つの参照先テーブル)で達成できるため、Dを採用する追加の理由がない。Cはgbrain既存コードベースの慣行(小さく管理された値集合をコード内enumではなくDB側の登録データとして持つ設計、例: schema-packsのレジストリパターン)とも一貫する。

**スキーマ**: `principal_kinds(id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NULL)`。初期データとして`human`/`service`/`agent`/`device`/`unknown`の5行をブートストラップする。`principals.kind_id`は`principal_kinds(id)`への外部キー、`NOT NULL DEFAULT 'unknown'`(Principal行は必ず何らかの種別ラベルを持つが、既定は「未確認」)。

**AUTHZ-INV-001との関係**: `principal_kinds`によるFK整合性は「値が安定して記録される」ことを保証するだけであり、それ自体は認可コードが`kind_id`を条件分岐に使うことを防止しない。防止するのは引き続きコードレビュー・テスト(AUTHZ-INV-001の検証方法・対応テスト候補)である。この点はA〜Dのどの案を採用しても同じであり、スキーマ設計だけで解決できる問題ではないことを明記しておく。

### 1-1b. Principal失効(`revoked_at`)のPhase 9B上の意味(確定)

**Phase 9Bは完全加算的・認可挙動不変とする。** 以下を明記する。

- Principal失効時、紐付くClientの認証を**拒否しない**。
- 既発行トークンを**無効化しない**。
- Clientのscope認可を**拒否しない**。
- Principal失効はClientへ**自動伝播しない**。
- Phase 9Bの時点で、Principalは**監査・帰属情報のみ**を表す。認証・認可のいかなる判定にも入力されない。
- Policy Decisionへの利用(失効の実効的な反映)は、管理画面統合を扱う**Phase 9D以降に先送り**する。
- 上記の帰結として、**Phase 9BではPrincipal失効操作(`revoked_at`への書き込み)を行う製品機能(CLI/API/UI)を一切公開しない**(詳細は§7「Phase 9Bで採用する案」参照)。`revoked_at`列はスキーマ上は存在するが、Phase 9Bのコードパスからは一切書き込まれない、将来のための予約列である。

### 1-2. Subject — 独立概念として採用しない(統合)

- **検討した定義**: 「Principalがシステム上でどう識別されるかの実体」
- **統合の理由**: gbrainの実装を精査した結果、`oauth_clients.client_id`が既に「ワイヤー上に現れる識別子」の役割を完全に果たしている。Subjectを別途設けると、`client_id`(Subject相当)と`principal_id`(Principal)という実質同じ機能の列が2つできてしまう。ユーザーが要求する「1 Subject対複数Principal」の具体例(§2-2参照)も、実際にはClient共有のケースであり、Subjectという第3の概念を導入しなくてもClient+Principal(nullable)の2層で表現できる。
- **本書での扱い**: 「Subject」という語がOAuth/JWT仕様や外部ドキュメントで使われる場合、それはgbrainの`Client`(+ その`principal_id`が指すPrincipal)に対応する、という対応表としてのみ記載する。gbrain内部に`subjects`テーブルは作らない。

### 1-3. Client

- **一文定義**: gbrainに接続する特定のソフトウェア・統合・実行環境を表す登録済みエンティティ。
- **責務**: 「どの統合が接続してきたか」の表現。Principalそのものではない。
- **一意性**: `oauth_clients.client_id`で一意(既存のまま)。
- **ライフサイクル**: 登録→有効→無効化(revoke)。既存の`revoked_at`/`revoke-client`がそのまま対応。
- **誰が作成するか**: 管理画面操作者、またはDCR(Dynamic Client Registration、有効な場合)。
- **他概念との多重度**: 1 Principal : 多 Client(既に実在、§1-1参照)。1 Client : 多 Principal は**Phase 9Bでは実装しない**が、モデル上禁止しない(§2-2参照)。
- **認証時に確定するか**: する(既存のOAuth検証がそのまま該当)。
- **現行gbrainの対応物**: `oauth_clients`テーブル(そのまま)。
- **DB永続化**: 既存のまま(変更なし)。
- **Phase 9Bで実装するか**: 変更なし。`principal_id`という1列の追加のみ。

### 1-4. Credential

- **一文定義**: PrincipalまたはClientが自らの正当性を証明するために提示する検証可能な秘密情報。
- **帰属先**: **ClientまたはPrincipalのいずれか**(§2-4で確定)。Subject(不採用)・Session・Execution Instance・Delegationには帰属しない。
- **責務**: 「これを提示できることが正当な保持者である証拠になる」という一点のみ。権限そのものは内包しない(AUTHZ-INV-014参照)。
- **現行gbrainの対応物**: `oauth_clients.client_secret_hash`(Client帰属)、`oauth_tokens.token_hash`(Client帰属、トークン発行はclient_credentials/authorization_codeいずれもクライアント文脈)、admin bootstrap token(Principal帰属想定、ただし現状はPrincipal概念自体が無いため実質「デプロイ全体」に帰属)。
- **DB永続化**: 既存のまま。
- **Phase 9Bで実装するか**: しない(Credential自体の構造変更はPhase 9Fの範囲)。

### 1-5. Session

- **一文定義**: 検証済みCredentialの提示によって開始される、時間的に区切られた有効期間。
- **OAuthアクセストークンの有効期間はSessionと呼ぶか**: **呼ぶ**。ただし新規テーブルは作らない。`oauth_tokens`の1行(`issued_at`〜`expires_at`)が既にSessionを体現している。
- **1トークンで複数リクエスト**: Sessionは1つ(トークンの有効期間全体)。個々のリクエストは後述のExecution Instance。
- **現行gbrainの対応物**: `oauth_tokens`(OAuth)、`adminSessions`(管理画面、インメモリ)。
- **DB永続化が必須か**: 既存の`oauth_tokens`で既に永続化されている。管理画面の`adminSessions`は現状インメモリのままでよい(Phase 9Bでは変更しない、Phase 9Dの検討事項)。
- **Phase 9Bで実装するか**: しない(概念としてラベル付けするのみ、新規実装なし)。

### 1-6. Execution Instance

- **一文定義**: 1回の境界づけられた実行単位(1件のMCP/HTTPリクエスト、または1件のジョブ)。
- **1リクエスト=1 Execution Instanceか**: そう扱う。
- **長時間ジョブと通常リクエストを同一概念で扱うか**: 扱う。両者とも「開始・終了があり、あるCredential/Clientに帰属し、監査対象になる境界づけられた作業」という共通点を持つ。
- **リトライ時のExecution Instance ID**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`§1で確認した通り、`replayJob`は新しいjob idを持つ**新しいジョブ**を作る(`parent_job_id = null`、`attempts_made: 0`)。したがってリトライは新しいExecution Instanceであり、元のインスタンスを「再開」するものではない。
- **委任ジョブと親リクエストの関連**: 現状、`submit_agent`呼び出しの`mcp_request_log`行と、それが生成した`minion_jobs.id`は**相互参照されていない**(補完監査で確認済みのギャップ)。
- **監査ログで必要となる識別子**: `mcp_request_log.id`(リクエスト用)と`minion_jobs.id`(ジョブ用)の2種類の主キーが、既に事実上のExecution Instance識別子として機能している。
- **全リクエストに永続的なExecution Instanceレコードが必要か**: **不要**。既存の`mcp_request_log`行自体がExecution Instanceの永続表現を兼ねる。新規テーブルを作る必要はない。
- **相関IDだけで十分なケース**: 全てのケースで十分。新規に「execution_instances」テーブルを作ることは、既存の`mcp_request_log`/`minion_jobs`の主キーと重複するだけの過剰設計になる。
- **Phase 9Bで実装するか**: 概念ラベルの明示のみ。ただし`mcp_request_log`に`job_id`(nullable)を追加し、`submit_agent`呼び出し行と生成ジョブを相関できるようにすることは、小さな追加改善として**Phase 9Bまたは9Cで検討可能**(必須ではない、候補)。

### 1-7. Delegation

- **一文定義**: あるPrincipal/Clientが自身の権限の部分集合を、別の実行(Execution Instance)に一時的に許可する関係。
- **現行gbrainの対応物**: `AgentClientBindings`(`oauth_clients.bound_*`列)+`submit_agent`のサブセット検証ロジック。実装は健全(補完監査4-5で確認済み)。
- **Phase 9Bで実装するか**: しない(Delegationの汎用化・孫委任対応はPhase 9Eの範囲。Phase 9Bは`submit_agent`のロジックに触れない)。

### 1-8. Capability / Permission

- 変更なし。`scope.ts`の6値がそのまま対応。Phase 9Bで変更しない。

### 1-9. Policy Decision

- 変更なし。`hasScope()`がそのまま対応。管理画面の`requireAdmin`との統合はPhase 9Dの範囲、Phase 9Bでは触れない。

### 1-10. Audit Event

- 一文定義・責務は`PHASE9A-TARGET-DOMAIN-MODEL.md`のまま変更なし。
- Phase 9Bで実装するか: `mcp_request_log`への`principal_id`列追加(nullable)は候補だが、Audit Event統合自体はPhase 9Cの範囲。Phase 9Bはこの列の追加を含めるかどうかを実装時に判断してよい(必須ではない)。

---

## 2. PrincipalとSubjectの関係(確定)

### 2-1. 結論

**分けない。統合する。** Client(既存)とPrincipal(新規)の2層構造とする。

### 2-2. 検討経緯

**1 Principal対複数Subjectが必要な具体例**: 「同じ人間がClaude Code・Codex・ChatGPT connectorという複数のOAuthクライアントを使う」——これは実在する(Phase 8で確認済み)。しかし、これは「1 Principal対複数**Client**」の話であり、Client自体が既にこの多重度を表現できる。Subjectという別の層を挟む必然性がない。

**1 Subject対複数Principalを認めるか**: 検討した結果、「複数人が同じClientを共有する」というケース(§2-3参照)は実際には「1 **Client**対複数Principal」の話であり、これもClient側にPrincipal参照を複数持たせる(または`principal_id`を都度リクエストで解決する)ことで表現でき、Subjectという概念を介する必要がない。

**判断**: PrincipalとSubjectを分ける合理的必要性は確認できなかった。したがって統合案(Client+Principalの2層)を採用する。これはユーザーの「抽象化を増やすこと自体を目的にしない」という要求に沿った、意図的にシンプルな選択である。

### 2-3. OAuthのclient_id等の対応関係

| 既存の識別子 | 対応する新概念 |
|---|---|
| `oauth_clients.client_id` | Client |
| トークン主体(`oauth_tokens`が指すclient) | Client(トークンはClientに紐づく。Principalには直接紐づかない) |
| 管理画面操作者 | Principal(ただし現状は「bootstrap token保有者」という1つの暗黙Principalとして扱う。個別化はPhase 9D以降) |
| サービスアカウント(将来) | Principal種別`service`として表現 |
| ジョブ所有者(`__owner_client_id`) | Client(Principalではない。ジョブは「Clientの委任」から生まれるため) |

### 2-4. 人間が共有Clientを使用した場合

Principalを特定できない、または複数人でClientを共有していることが分かっている場合は、`principal_id = null`(Client-onlyの状態)として扱う。**これを「anonymous」「denied」のいずれか一方に決め打ちしない**——読み取り・書き込みの可否はあくまでClientの`scope`列によって決まり、Principal不明であること自体はCapabilityの可否を変えない(AUTHZ-INV-001,003参照)。Principal不明は監査上「誰が」の欄が空くだけであり、認可上のペナルティにもボーナスにもならない。

---

## 3. ClientとPrincipalの分離(要件確認)

`PHASE9A-CURRENT-STATE-AUDIT.md`で確認済みの通り、`oauth_clients`は既に「Client名や製品名を権限根拠にしない」設計になっている(`scope.ts`はclient_nameを一切参照しない)。今回追加する`principal_id`列も同様に、Policy Decision(`hasScope`)の入力には**含めない**——Principalは監査・グルーピング専用の参照であり、認可判断には使わない(そもそもPrincipal種別だけで権限を決めないというAUTHZ-INV-001と表裏一体)。

- 1 Principalが複数Clientを使用できる: ✓(`oauth_clients.principal_id`が同じ値を複数行が持てる)
- 1 Clientを複数Principalが利用できる可能性: モデル上禁止しないが、Phase 9Bでは`oauth_clients.principal_id`を単一のnullable FKとして実装する(1 Client : 高々1 Principal)。真に複数Principalの共有Clientを扱う必要が生じたら、Phase 9B以降で別途「リクエストごとのPrincipal解決」を検討する(未実装、将来拡張点として明示)。
- Principal不明のClient-only接続: ✓(`principal_id = null`が有効な状態)
- Client登録とPrincipalの信頼登録の非混同: DCR(有効な場合)はClient行を作るのみで、`principal_id`は既定でnullのまま。**DCRだけでPrincipalが自動的に信頼済みになることはない**(AUTHZ-INV-012)。
- Client CredentialとPrincipal Credentialの区別: `oauth_clients.client_secret_hash`はClient Credential。管理画面bootstrap tokenはPrincipal Credential相当(ただし現状は個別Principal行と結びついていない、Phase 9D検討事項)。

---

## 4. Credentialの帰属(確定)

**最小構成**: ClientまたはPrincipalのいずれかに帰属する。Session・Execution Instance・Delegationには帰属しない。

- Client帰属: `client_secret_hash`、`oauth_tokens`(client_credentials/authorization_codeいずれも最終的にクライアント文脈で検証される)
- Principal帰属: 管理画面bootstrap token(概念上。実装は現状「デプロイ単位の1シークレット」であり、複数Principal各自のCredentialにはなっていない。個別化はPhase 9D以降)

**Credentialは権限を内包するか、証拠に過ぎないか**: **証拠に過ぎない**。これは新しい設計判断ではなく、gbrainの既存実装が既にそうなっている(`oauth_tokens`はスコープを埋め込まず、検証時に`oauth_clients.scope`を都度JOINして解決している——`PHASE9A-CURRENT-STATE-AUDIT.md`で確認済み)。Phase 9Bはこの既存の健全な設計を変更しない。

---

## 5. SessionとExecution Instanceの違い(確定)

§1-5・1-6で確定した内容の通り:

- OAuthアクセストークンの有効期間 = Session(新規テーブル不要、`oauth_tokens`が体現)
- 1リクエスト = Execution Instance(新規テーブル不要、`mcp_request_log.id`が体現)
- 1ジョブ = Execution Instance(新規テーブル不要、`minion_jobs.id`が体現)
- 1トークンで複数リクエスト: Session 1つ、Execution Instance複数
- リトライ: 新しいExecution Instance(既存のreplayJob設計と整合)
- 全リクエストへの永続レコード: 既存の`mcp_request_log`書き込みで既に満たされている(新規の大量DBレコード生成は不要)

---

## 6. 具体例による検証

| ケース | Principal | Client | Credential | Session | Execution Instance |
|---|---|---|---|---|---|
| 人間が専用Clientを使う(例: 個人用Claude Code) | 特定のPrincipal行 | 専用の`oauth_clients`行、`principal_id`がそのPrincipalを指す | client_secret / token | oauth_tokensの1行 | 個々のMCPリクエスト |
| 人間が共有Clientを使う(複数人で1つの登録) | null、または将来拡張で都度解決 | 共有の`oauth_clients`行、`principal_id=null` | 同上 | 同上 | 同上 |
| 非対話型サービス(サーバー間) | Principal種別`service`のPrincipal行(または匿名) | client_credentials用Client | client_secret | oauth_tokens | 各API呼び出し |
| 自律型エージェント(agentスコープ保持Client) | Principal種別`agent`、または人間Principalに従属(そのエージェントを「所有」する人間の配下として`principal_id`を人間のPrincipalに揃えることも可) | agentスコープのoauth_clients行 | client_secret | oauth_tokens | submit_agent呼び出し1件 |
| 一時サブエージェント(submit_agentで生成されたjob) | Principal概念を持たない(Delegationを通じて`__owner_client_id`のClientに帰属) | 該当なし(jobはClientではない) | 該当なし(新規credential発行なし) | 該当なし | `minion_jobs.id`そのもの |
| Principal不明の登録済みClient | null | 通常のoauth_clients行 | あり | あり | あり |
| 失効済みClient | 元のPrincipal参照は保持(監査目的で残す) | `revoked_at`セット済み | 検証時に拒否 | 既存トークンも即時無効(revoke-clientの既存実装通り) | 失効後のリクエストはExecution Instanceとして「拒否」の形で記録される |
| ローカルCLI | Principal概念なし(OS境界に委ねる、既存のまま変更しない) | 該当なし(CLIはClientではない) | なし(OS実行権限のみ) | なし | 個々のCLI呼び出し(ただし現状mcp_request_logには記録されない、補完監査3-3参照) |
| 管理画面操作者 | 概念上は単一の暗黙Principal(bootstrap token保有者)。個別化はPhase 9D | 該当なし | bootstrap token | adminSessions(インメモリ) | 個々の管理画面API呼び出し(ただし現状監査記録なし、補完監査2-3参照) |

---

## 7. Phase 9Bで採用する案(確定 — 案A)

Phase 9BでPrincipalを操作可能にする範囲について、「案A: 基盤のみ」と「案B: 最小運用可能単位」を比較し、**案Aを採用する**。

- 実装するもの: `principals`テーブル、`principal_kinds`登録テーブル、`oauth_clients.principal_id`、`AuthInfo`へのnullable情報追加、これらの読み取り・内部モデル・テストのみ。
- 実装しないもの: Principal作成・紐付けを行うUI/API/CLI(`/admin/api/principals`を含む)。既存Clientへの手動紐付け手段(製品機能としては提供しない)。Principal失効操作(§1-1b参照)。
- 結果として、**全既存Clientの`principal_id`はnullのまま**であり、Phase 9B完了時点では実運用上Principalを設定する手段が製品として存在しない。これはPhase 9Bの完了条件違反ではなく、意図した設計である——Phase 9Bは「データモデルと認証コンテキストの下地を用意すること」が目的であり、実際の運用開始(Principal作成・紐付け)は次Phase以降の判断とする。
- 運用者がDBに直接SQLでPrincipal行を作成し`principal_id`を設定することを技術的に妨げはしないが、これはサポートされた操作ではなく、Phase 9Bの完了条件・テスト対象には含めない。

## 8. Phase 9Bとの接続

本書で確定した「Principal(新規、最小、`principal_kinds`登録テーブルで種別管理)+Client(既存)の2層、Subject不採用、Session/Execution Instanceは概念ラベルのみで新規テーブル不要、Principal失効は帰属情報のみで認可挙動に影響しない、案A(基盤のみ)採用」という結論は、`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`の実装範囲の根拠となる。
