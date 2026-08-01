# Phase 9A — 目標ドメインモデル(概念設計・実装ではない)

**日付**: 2026-07-31(初版) / 2026-08-01(確定版 — Subject不採用を反映)
**位置づけ**: 本書は実装案ではありません。「Universal Knowledge Layer」が最終的に持つべき**必要最小限の概念とその責務**を定義するものです。命名は既存コード(`PHASE9A-CURRENT-STATE-AUDIT.md`参照)と整合する箇所は極力揃え、新規に用語を増やしていません。実装方式(テーブル設計・API形状・具体的なクラス構造)には踏み込みません。

> **2026-08-01改訂の要点**: 初版では「Principal」と「Subject」を別々の概念として提示していましたが、`PHASE9A-IDENTITY-MODEL-DECISION.md`での検討の結果、**Subjectは独立した永続概念として採用しないことを確定しました**。gbrainには「1つのワイヤー識別子(client_id)が複数の主体を代表する」という実在の必要性が確認できず、Subjectを別途設けるとClient(既存`oauth_clients`)と実質的に重複する第3の概念になってしまうためです。本書は「必要最小限の概念」という自らの位置づけと整合させるため、Subjectを概念一覧・関係図から削除し、**Principal + Client の2層構造**に統一しました。詳細な検討経緯は`PHASE9A-IDENTITY-MODEL-DECISION.md`§2を参照してください。

---

## 前提: なぜこのモデルが必要か

`PHASE9A-CURRENT-STATE-AUDIT.md`の判定(§Universal化10項目)で**FAIL**となった項目4・5・9は、いずれも「主体を統一的に区別・表現するモデルが存在しない」ことに起因します。以下の概念群は、その欠落を埋めるための最小集合です。既存の`AuthInfo`/`oauth_clients`/`AgentClientBindings`を置き換えるのではなく、**その上位に位置する概念的な整理**として提示します。

---

## 概念一覧(10概念、Subjectは不採用)

### 1. Principal(主体)

「何らかの意思決定の帰属先となりうるもの」の最上位概念。人間・サービス・AIエージェント・デバイス・未確認(unknown)はすべてPrincipalの具体化(種別)である、という位置づけ。

- **責務**: 他の概念(Client/Credential/Delegation)が最終的に「誰の権限か」を遡って辿れる終点を提供すること。
- **現状との対応**: 現状は存在しない。最も近いのは`oauth_clients`(ただしこれはPrincipalではなく後述のClientに相当)。
- **なぜ製品名で分岐しないか**: Principalの種別はHuman/Service/Agent/Device/Unknownのような**役割的分類**であり、「どの製品か」ではなく「どういう種類の意思決定主体か」で分ける。ベンダー名はPrincipalの属性にすら現れない。
- **Principalの種別保存方式**: `PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1・`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`で確定した通り、固定CHECK制約ではなく`principal_kinds`という小さな登録テーブルへの参照とする(未知の種別追加時にスキーマ変更を要しない)。ただし種別は表示・監査専用であり、Capability判定の入力にはしない(`AUTHZ-INV-001`)。

### 2. Client(クライアント)

特定の実行環境・アプリケーション・統合先を表す。現状の`oauth_clients`テーブルがほぼこのまま対応する。

- **責務**: 「どのソフトウェア/統合が接続してきたか」を表現する。Principalそのものではない(1つのPrincipalが複数のClientを使うこともあれば、Principalが未確定のままのClientも存在しうる)。
- **PrincipalとClientの関係**: 1 Principal : 多 Client(実在するケース。同一人物がClaude Code・Codex・ChatGPT connectorという複数のoauth_clients行を使用している、`PHASE9A-SUPPLEMENTAL-AUDIT.md`で確認済み)。1 Client : 多 Principal(複数人での共有Client)はモデル上禁止しないが、Phase 9Bでは実装しない(`principal_id`は単一のnullable参照)。
- **現状との対応**: `oauth_clients`テーブル(`schema.sql:642-664`)がそのまま対応。良好。
- **ClientとPrincipalの非混同**: Client登録(DCRを含む)は、それだけでPrincipalが自動的に信頼済みになることを意味しない(`AUTHZ-INV-012`)。新規登録Clientの`principal_id`は既定でnull。

### 3. Credential(資格情報)

PrincipalまたはClientが自らの正当性を証明するための秘密情報の抽象。

- **責務**: 「これを提示できることが、それを保持する権利の証明になる」という一点のみに責任を持つ。スコープや権限の集合そのものは持たない(それはCapability/Policy Decisionの責務)。
- **帰属先**: Client、またはPrincipalのいずれか(`PHASE9A-IDENTITY-MODEL-DECISION.md`§4で確定)。Execution Instance・Delegationには帰属しない。
- **現状との対応**: `oauth_clients.client_secret_hash`/`oauth_tokens.token_hash`/`access_tokens.token_hash`(いずれもClient帰属)、管理画面bootstrap token(概念上Principal帰属だが、現状は個別Principalと未結合)。GitHub Webhookの`webhook_secret`は`sources`(Source)に帰属する、性質の異なる第4のCredential相当物であり、Principal/Client向けCredentialの一本化対象には含めない(`PHASE9A-CURRENT-STATE-AUDIT.md`§2「認証機構の分類」参照)。

### 4. Session(セッション)

Credentialの提示によって開始される、時間的に区切られた利用期間。

- **責務**: 「いつからいつまで有効か」「その間の利用状況をどう追跡するか」を表現する。
- **現状との対応**: 新規テーブルは不要。既存の`oauth_tokens`(1行=1 Session)と管理画面の`adminSessions`が既にこの概念を体現している。

### 5. Execution Instance(実行インスタンス)

ある一回の実行(1リクエスト、1ジョブ)を表す最小単位。

- **責務**: 「いつ・どの権限で・どのClientの依頼によって」実行されたかを一意に特定できるようにする。
- **現状との対応**: 新規テーブルは不要。既存の`mcp_request_log.id`(1リクエスト)と`minion_jobs.id`(1ジョブ)が既にこの概念を体現している。リトライ(`replayJob`)は新しいExecution Instance(新しいjob id、`parent_job_id=null`)を生成する。

### 6. Delegation(委任)

あるPrincipal(またはClient)が、自身の権限の全部または一部を、別のExecution Instanceに一時的に譲渡する関係。

- **責務**: 「誰が誰に何を許可したか」「その譲渡が元の権限のサブセットであることの保証(narrowing)」を表現する。
- **現状との対応**: `submit_agent`/`AgentClientBindings`(`oauth-provider.ts:35-42`, `operations.ts:3038-3192`)がこの概念の実装として最も成熟している。実際に権限のサブセット検証を行っている点は良好。ただし「クライアント→ジョブ」の1階層のみを扱い、孫委任は現状不可能(`PHASE9A-SUPPLEMENTAL-AUDIT.md`§4で確認済み — subagentのツールレジストリに`submit_agent`自体が含まれないため、汎用的な「PrincipalからPrincipalへの委任」としては一般化されていない)。

### 7. Capability / Permission(能力・権限)

特定の操作を実行してよいという許可の単位。

- **責務**: 「何ができるか」を表現する。誰がそれを持つか(Principal)、どう判定するか(Policy Decision)とは独立して定義される。
- **現状との対応**: `scope.ts`の6値フラットスコープがこれに対応。製品非依存・プロトコル非依存であり、この点はUniversal設計として良好。ただし粒度が粗く(例: deleteとwriteが同一スコープ)、将来の拡張(細粒度の権限)の余地は残る。

### 8. Policy Decision(認可判断)

あるExecution InstanceがあるCapabilityを行使してよいかどうかの、その場その場の判定結果。

- **責務**: 「なぜ許可された/拒否されたか」の理由を含めて判定を行う。判定ロジック自体はPrincipal種別・プロトコル種別に依存しない入力(Client, Credential検証結果, Capability, 対象リソース)のみから決定されるべき(`AUTHZ-INV-001`)。
- **現状との対応**: `hasScope()`(`scope.ts`)がこの責務を担う。プロトコル非依存である点は良好(MCP/HTTPが同一検証器を共有)。ただし管理画面はこの判定を経由しない別系統(`requireAdmin`)であり、Policy Decisionの一本化はできていない(`AUTHZ-INV-010`違反、Phase 9Dで是正対象)。GitHub Webhook HMACはそもそもPolicy Decision(Capability判定)に到達しない、構造的に異なるメッセージ真正性検証である。

### 9. Audit Event(監査イベント)

「いつ・誰が(Principal)・どのClientを介して・どのExecution Instanceで・何を(Capability)・誰の委任のもとで」行ったかを記録する不変のレコード。

- **責務**: Principal/Client/Execution Instance/Delegationのいずれとも参照整合性を持ち、事後に追跡可能であること。
- **現状との対応**: `mcp_request_log`(操作ログ、FK制約なし)と`agent-audit.ts`のJSONL(委任ログ、ベストエフォート)の2系統に分裂しており、いずれもPrincipal/Delegationへの正式な参照を持たない。加えて、記録範囲自体が経路ごとに非対称であることを確認済み(`/ingest`は拒否・失敗を記録しない、CLI・管理画面・GitHub Webhookは一切記録しない — `PHASE9A-SUPPLEMENTAL-AUDIT.md`§3)。ここがUniversal化における最大のギャップの一つ。

### 10. Organization / Tenant(組織・テナント、将来拡張点)

複数のPrincipalが所属し、データ・権限境界を共有する上位グルーピング。

- **責務**: 将来、複数組織/複数ユーザーが同一の知識層を利用する場合の、データ分離・権限境界の単位を提供する。
- **現状との対応**: 概念自体が存在しない。`source_id`によるデータソース単位の分離が、最も近い代替概念として機能している。gbrain自身の既存設計文書(`docs/designs/MINIONS_AGENT_ORCHESTRATION.md`)が既に「Phase 3: Multi-tenant auth」として将来計画に含めており、この欠落は既知・計画済みのものである(`PHASE9A-SUPPLEMENTAL-AUDIT.md`§1)。

---

## 概念間の関係(責務の分離、実装ではない)

```
Principal ──(Clientを介して接続する、principal_idは任意/nullable)──> Client
                                                                        │
                                                                  (提示する)
                                                                        ▼
                                                                  Credential
                                                                        │
                                                                   (開始する)
                                                                        ▼
                                                                    Session
   │
   ├──(委任する)──> Delegation ──(生成する)──> Execution Instance
   │                                                        │
   │                                              (行使を試みる)
   │                                                        ▼
   │                                              Capability/Permission
   │                                                        │
   │                                                 (判定される)
   │                                                        ▼
   │                                              Policy Decision
   │                                                        │
   │                                                  (記録される)
   │                                                        ▼
   └──(帰属先として記録される、Principal未確定でも記録可能)──>  Audit Event

(将来) Organization/Tenant は Principal の集合を束ね、
       Policy Decision と Audit Event の双方に境界条件を追加する。
```

**この図が示す設計原則**: どの矢印にも製品名・プロトコル名は現れません。Principal種別(人間/AI/サービス/デバイス/unknown)、接続方式(MCP/HTTP/CLI)は、この図の外側(Clientの実体化のされ方)にのみ現れ、Delegation〜Policy Decision〜Audit Eventという中核の流れには影響しません。これは`PHASE9A-CURRENT-STATE-AUDIT.md`で確認した「認可コアに製品名分岐が存在しない」という現状の良好な性質を、意図的に踏襲・強化する設計です。**Subjectという第3の層は置きません**(不採用の理由は`PHASE9A-IDENTITY-MODEL-DECISION.md`§2)。

---

## 外部仕様における「Subject」との対応(用語対応のみ、独立概念ではない)

OAuth 2.0/2.1・JWT(`sub`クレーム)・SAML等の外部仕様で「Subject」という語が使われる場合、それはgbrainの内部モデルでは**Client(+ その`principal_id`が指すPrincipal、存在する場合)**に対応します。gbrainのソースコードやDBスキーマに`subjects`テーブルや`Subject`型を新設することはありません。これは用語の対応表であり、実装上の独立概念ではないことに注意してください。

---

## 命名についての補足

- `Principal`/`Delegation`/`Policy Decision`/`Audit Event`は、既存コードに同名の型がないため、業界一般の認可設計(NIST RBAC/ABAC文献、OAuthの`principal`概念等)に準拠した名称を採用しました。
- `Client`/`Credential`/`Session`/`Capability`は既存コード(`oauth_clients`, `client_secret_hash`, `adminSessions`, `scope.ts`のScope)の呼称とすでに一致しており、そのまま踏襲しています。
- `Execution Instance`は既存の`minion_jobs`/`mcp_request_log`の実態に最も近い概念ですが、テーブル名と概念名を意図的に区別しました(新規テーブルを作らず、既存の主キーがそのままExecution Instance識別子として機能するため)。
- `Organization/Tenant`は現状皆無のため、業界標準の呼称をそのまま採用しています。
- `Subject`は検討の上、独立概念として不採用としました(理由は`PHASE9A-IDENTITY-MODEL-DECISION.md`§2「PrincipalとSubjectの関係」を正本とする)。

本書は概念定義のみであり、これらをどう実装するか(新テーブルを作るか、既存テーブルを拡張するか等)は`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`が正本です。
