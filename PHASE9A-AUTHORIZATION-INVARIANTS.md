# Phase 9A — 認可不変条件(AUTHZ-INV-001〜017)

**日付**: 2026-08-01(初版) / 2026-08-03(AUTHZ-INV-005改訂・016・017追加 — Phase 9E着手前設計決議、Opus単独レビュー→ユーザー承認)
**位置づけ**: Phase 9B以降の実装が守るべき不変条件を、テスト可能な形で明文化する。各条件は`PHASE9A-CURRENT-STATE-AUDIT.md`・`PHASE9A-SUPPLEMENTAL-AUDIT.md`で確認した実コードの事実、および`PHASE9A-IDENTITY-MODEL-DECISION.md`で確定した概念モデルを根拠とする。本書自体は実装ではなく、実装が満たすべき条件の定義である。

> **2026-08-03改訂の要点**: Beads `dashboard-5krlu`(narrowing fail-open修正)の調査過程で、AUTHZ-INV-005が「Capability」の外延を定義していないこと、および委任開始権(`agent` scope)と委任対象能力の保有が現状分離されていないことが判明した。Opus単独レビュー2回(設計・優先度判定→正式決議案)を経て、AUTHZ-INV-005を改訂し、AUTHZ-INV-016・017を新設した。詳細な決議根拠は`PHASE9E-DELEGATION-DOMAIN-MODEL.md`を参照。

---

## AUTHZ-INV-001: Principal種別・Client種別・製品名・ベンダー名・プロトコル名だけでCapabilityを決定しない

- **規則**: 「Humanだからadmin」「Agentだからagent scope」「Serviceだからclient_credentials可能」「Deviceだから低権限」「既知製品だから信頼」「未知製品だから拒否」「特定ベンダーだから強い権限」「特定プロトコルだから信頼」のような、種別・名称のみに基づく権限分岐を禁止する。
- **理由**: `PHASE9A-CURRENT-STATE-AUDIT.md`§3・§6で確認した通り、現行の`scope.ts`はクライアント名・ベンダー名を一切参照せず、`hasScope()`の判定はスコープ集合のみに基づく。この健全な性質を今後も維持するための明文化。
- **違反例**: `if (principal.type === 'human') scopes.push('admin')`のようなコード、または`if (clientName === 'claude-code') allowExtraTool()`のような分岐。
- **検証方法**: 認可コア(`scope.ts`, `operations.ts`のhasScope呼び出し箇所)をgrepし、`principal.type`・`kind_id`・`client_name`・`vendor`・`protocol`のいずれかを条件式に含むCapability判定が存在しないことを確認する。
- **対応テスト候補**: 同一スコープ・異なるPrincipal種別(`principal_kinds`登録済みのhuman/service/agent/device/unknown、および将来追加される未知種別)のパターンで同一操作を実行し、認可結果が種別に依存せず一致することを確認するパラメタライズドテスト。
- **実装上の補足**: Principal種別は`PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1aで確定した`principal_kinds`登録テーブル参照方式で保存される(固定CHECK制約ではなく、新規種別はデータ行の追加のみで拡張可能)。この保存方式自体は種別値の安定性・タイプミス耐性を高めるが、認可コードが`kind_id`を条件分岐に使わないことを構造的に強制するものではない——それを担保するのは本条件のコードレビュー・テストのみである。

## AUTHZ-INV-002: 権限は明示的に検証可能な情報源からのみ導出される

- **規則**: 権限は、Credentialの検証結果・Client登録状態・Principalとの確認済み関連・明示的なCapability grant・対象Resource・Policy評価・Delegation・有効期限・失効状態・信頼境界・Organization/Tenant境界、のいずれかからのみ導出する(Subjectは独立概念として採用していないため本条件の列挙対象に含めない、`PHASE9A-IDENTITY-MODEL-DECISION.md`参照)。それ以外(自己申告のヘッダ値、User-Agent文字列、IPアドレスの善意の推定等)を権限根拠にしない。
- **理由**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`§2で確認した通り、gbrainには既に「単一の`requireAdmin`ゲートのみで全操作が許可される」という粗い設計が実在する。今後この粗さを新たな形で再生産しないための歯止め。
- **違反例**: リクエストヘッダの`X-Client-Type: trusted-agent`を信じて権限を昇格する実装。
- **検証方法**: 認可判定に到達する変数の出自を追跡し、DBまたは検証済みトークンから来ていない値(リクエストの生ヘッダ・クエリパラメータ)が権限判定の入力になっていないことを確認する。
- **対応テスト候補**: 偽装したヘッダ・パラメータを含むリクエストを送り、権限が変化しないことを確認する否定的テスト。

## AUTHZ-INV-003: 未検証の主体に暗黙の権限を与えない

- **規則**: Credentialの検証に成功していない主体、またはPrincipalが未確定(unknown)の主体に対して、明示的なCapability grantなしに何らかの権限を暗黙に付与しない。
- **理由**: ユーザー要求「未知の主体やクライアントの自己申告だけで権限を付与しない」に対応。
- **違反例**: 「Client未登録だが、とりあえずreadは許可する」というデフォルト許可。
- **検証方法**: 未登録Client・未検証トークンでのリクエストが例外なく401/403で終わることを確認する。
- **対応テスト候補**: 存在しないclient_id、失効済みトークン、署名不一致のWebhookリクエストそれぞれについて、一切の操作が許可されないことを確認する回帰テスト。

## AUTHZ-INV-004: Unknownは全面許可・全面拒否の二択にしない

- **規則**: 「登録前」「登録済みだがPrincipal未関連付け」「Credential検証済み・Capability未付与」「Capability限定付与」「失効済み」「匿名利用」「オフライン時のキャッシュ済み権限」という段階的な状態を区別し、単純な二値(許可/拒否)に潰さない。
- **理由**: `PHASE9A-IDENTITY-MODEL-DECISION.md`§2-4で確定した通り、「Principal不明」はClientの`scope`に従って通常通り動作する有効な状態であり、拒否理由にも許可理由にもならない。これを今後のPolicy Decision設計でも維持する。
- **違反例**: `if (!principalId) return DENY_ALL;`(Principal不明を理由に全操作拒否)、または`if (!principalId) return ALLOW_ALL;`(逆に無条件許可)。
- **検証方法**: `principal_id = null`のClientが、通常通りそのClientのscopeに基づいて操作可否が決まることを確認する。
- **対応テスト候補**: Principal未関連付けのClientで、scope='read'なら読み取りは成功しwrite操作は拒否される、という通常のscope判定がPrincipal状態に左右されないことを確認するテスト。

## AUTHZ-INV-005: 委任先の権限は委任元の有効権限の部分集合を超えない

- **Capabilityの定義(本条件の適用対象、2026-08-03確定)**: 本書におけるCapabilityとは**(操作集合 × 名前空間)**の組とする。名前空間は`(direction, source_id, slug_prefix_set)`の3つ組であり、`direction ∈ {read, write}`。書き込み名前空間は`bound_source_id`と`bound_slug_prefixes`により、読み取り名前空間は`source_id`/`federated_read`により決まる(読み取り側のslug prefix制限は現状存在せず、`docs/designs/COMMUNITY_IDEAS.md`§6「Read-side prefix/federation enforcement」で既知の上流課題として追跡中)。予算(`budget_usd_per_day`)・並列度(`bound_max_concurrent`)・資格情報有効期限・委任深さは**Capabilityではなく Delegation Constraint** として分離し、本条件(部分集合)ではなくAUTHZ-INV-006/007の**単調性**(親の値より緩くならない)の対象とする。集合の包含と数値の順序を同じ「部分集合」の語で括らない。
- **規則**: DelegationによってExecution Instanceへ渡されるCapabilityは、委任元Principal/Clientが現に保持する有効なCapabilityの部分集合でなければならない。判定は、操作集合については包含、名前空間についてはdirectionごとの包含(`source_id`の一致またはfederation集合への包含、かつslug prefixのスラッシュ境界を考慮した包含)で行う。Delegation Constraintは部分集合ではなく「親の値より緩くならない」単調性で判定する。
- **理由**: `submit_agent`の既存実装(`src/core/operations.ts`の`submit_agent`ハンドラ、slug prefix検証は同ファイル`isRequestedSlugPrefixWithinBound`呼び出し箇所)が操作集合(`bound_tools`)と書き込みslug prefix(`bound_slug_prefixes`)についてこれを実践している。この健全な性質を委任汎用化(Phase 9E)でも失わないための固定。
- **違反例**: 委任先ジョブが、委任元Clientの`bound_tools`に含まれないツールを呼び出せる実装。委任先ジョブが委任元Clientの書き込みsourceと異なるsourceへ書き込める実装。
- **検証方法**: 委任リクエストで委任元のCapabilityを超える`allowed_tools`/`allowed_slug_prefixes`を要求した場合に`permission_denied`で拒否されることを確認する。加えて、委任先が実際にツールを行使する経路(subagentのツールレジストリ)でも同じ包含判定が効いていることをコードパス追跡で確認する。
- **対応テスト候補**: 既存テスト(`test/operations-allow-list.test.ts`・`test/submit-agent.test.ts`の`submit_agent`サブセット検証テスト)を維持し、Phase 9E以降の汎用化実装でも同一のテストケースが通ることを回帰確認する。加えて、grant時とexercise時の判定が同一述語を共有していること(`isRequestedSlugPrefixWithinBound`と`matchesSlugAllowList`の整合、`dashboard-5krlu`由来)をproperty-basedで確認する。
- **既知の未充足(Phase 9E-2で是正予定)**:
  1. `bound_source_id`が未設定の場合、委任ジョブの実行時sourceは委任元Clientの`source_id`ではなく`'default'`になる(`src/core/minions/tools/brain-allowlist.ts`の`buildOpContext`)。名前空間軸の部分集合性がsourceについて現在成立していない(Beads `dashboard-z7a1o`で追跡)。
  2. 委任先のツール実行は`authorizeOperation()`/`hasScope()`を経由しない(`src/core/minions/tools/brain-allowlist.ts`の`execute`、`buildOpContext`は`auth`を設定しない)。包含はgrant時のみ検証され、exercise時は`enforceSubagentSlugFence`と`bound_tools`フィルタで代替されている。

## AUTHZ-INV-006: 各階層で委任は再評価され、委任元の失効は委任先へ伝播する

- **規則**: 委任チェーンが複数階層になった場合、各階層は自身より上位の委任元の現在の有効性(失効状態)を都度確認する。委任元の失効後は、既に生成された委任先の実行も新規の権限行使を継続できない。
- **理由**: 現状(1階層限定)ではこの問題は顕在化しないが、Phase 9Eで階層化する場合に備えた予防的条件。`revoke-client`が既存トークンを即時401にする現行実装(`PHASE9A-CURRENT-STATE-AUDIT.md`§9)と整合する設計にするため。
- **違反例**: 委任元Clientをrevokeした後も、既に投入された委任先ジョブが実行を継続し新たな権限行使(ツール呼び出し等)を行える実装。
- **検証方法**: 委任元をrevokeした直後に、実行中の委任先ジョブが新規のツール呼び出し・権限を要する操作を試みた場合に拒否されることを確認する。
- **対応テスト候補**: 委任元revoke後、実行中ジョブの次のツール呼び出しが失敗することを確認する統合テスト(Phase 9E実装時に追加)。

## AUTHZ-INV-007: 委任の有効期限は元資格情報の有効期限を超えない

- **規則**: Delegationによって生成されるExecution Instance(ジョブ等)の有効期間は、委任元Credentialの`expires_at`を超えて存続してはならない。
- **理由**: 委任が元の資格情報より長生きすると、Credential失効後も委任経由で権限が生き残るという抜け道になる。
- **違反例**: トークンのTTLが1時間なのに、委任されたジョブの`timeout_ms`が24時間に設定され、トークン失効後もジョブが動き続ける。
- **検証方法**: 委任生成時に、委任元トークンの残り有効期間と委任先の最大実行時間を比較し、前者を超えないことを確認する。
- **対応テスト候補**: 短いTTLのトークンで長時間ジョブの委任を試み、ジョブがトークン失効時刻を超えて権限を行使できないことを確認するテスト(Phase 9E実装時に追加。現状の`submit_agent`は`timeout_ms`のデフォルト値が固定されており、トークンTTLとの突き合わせは行っていないことを`PHASE9A-SUPPLEMENTAL-AUDIT.md`は確認していない — 未確認事項として残る)。

## AUTHZ-INV-008: 再委任は明示的に許可された場合のみ可能で、元の権限を超えない

- **規則**: 委任先がさらに別の実行へ再委任(孫委任)できるかどうかは、委任元が明示的に許可した場合のみ有効とする。許可されていても、再委任先の権限は元のPrincipal/Clientの権限を超えない。
- **理由**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`§4で確認した通り、現状は孫委任の手段自体が存在しない(subagentのツールレジストリに`submit_agent`が含まれない)。Phase 9Eで孫委任を実装する場合に備えた予防的条件。
- **違反例**: 委任先ジョブが無条件に`submit_agent`相当のツールを持ち、委任元の許可なく任意に孫ジョブを生成できる実装。
- **検証方法**: 孫委任を許可されていない委任先が、孫ジョブ生成を試みた場合に拒否されることを確認する。
- **対応テスト候補**: Phase 9E実装時に、「再委任許可あり/なし」の2パターンで孫ジョブ生成の可否が分かれることを確認するテスト。

## AUTHZ-INV-009: 委任チェーンは監査で再構成できる

- **規則**: あるExecution Instanceについて、それがどの委任チェーン(どのPrincipal/Client→どのDelegation→どのExecution Instance)から生じたかを、監査ログから遡って再構成できなければならない。
- **理由**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`§3-6・§4-5で確認した通り、現状`mcp_request_log`と`agent-audit.ts`のJSONLは相互参照されておらず、委任チェーンの再構成は不可能。この欠落をPhase 9C(Audit Event統合)で解消する際の到達目標として明文化する。
- **違反例**: あるジョブがどのOAuthクライアントの委任で生成されたかは`__owner_client_id`から分かるが、その呼び出し元リクエスト自体の監査行(`mcp_request_log`)には対応するjob_idが記録されておらず、双方向に辿れない。
- **検証方法**: 任意のジョブIDから、それを生成したsubmit_agent呼び出しの`mcp_request_log`行を一意に特定できること、およびその逆方向の参照ができることを確認する。
- **対応テスト候補**: submit_agent呼び出し→ジョブ生成→ジョブ完了、という一連の流れを監査ログのみから再構成できることを確認する結合テスト(Phase 9C実装時に追加)。

## AUTHZ-INV-010: プロトコルアダプターは認可コアを迂回できない

- **規則**: MCP・HTTP・CLI・管理画面・将来のプロトコルアダプターのいずれも、認証結果・Principal(または未確定状態)・Client・Credential検証結果・Session・Execution Instance・要求Capability・対象Resource・Delegation context・信頼境界情報を認可コアへ渡すのみとし、アダプター自身が最終許可判断を完結させてはならない。ネットワーク到達制御・構文検証・レート制限等のアダプター固有処理は分離して保持してよい。GitHub Webhookのようにそもそも主体認証(Principal/Client識別)を伴わないメッセージ真正性検証のみのアダプターは、本条件の対象外とする(`PHASE9A-CURRENT-STATE-AUDIT.md`§2「認証機構の分類」参照)。
- **理由**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`§2で確認した通り、現状の管理画面(`requireAdmin`)は認可コア(`hasScope`)を経由しない独立した最終判断を下しており、この不変条件に**現時点で違反している**(Phase 9Dで是正対象)。
- **違反例**: 現行の`requireAdmin`ミドルウェアが、`hasScope`を一切呼び出さずに「Cookie一致=全操作許可」を単独で完結させている状態。
- **検証方法**: 各アダプターのエントリポイントが、最終的に共通のPolicy Decision関数(`hasScope`相当)を経由してから初めてハンドラ本体を実行することを、コードパス追跡で確認する。
- **対応テスト候補**: 管理画面・MCP・HTTPそれぞれについて、共通のPolicy Decision関数にモックを仕込み、全アダプターがそれを実際に呼び出すことを確認する統合テスト(Phase 9D実装時に追加)。

## AUTHZ-INV-011: ローカル実行は無条件の全面信頼の新たな根拠として拡張しない

- **規則**: 「ローカル実行であること」は現状OS境界への委譲として扱われている(`PHASE9A-SUPPLEMENTAL-AUDIT.md`§5)。この既存挙動を変更するものではないが、将来新しい認可判断を追加する際に「ローカルだから」を単独の許可根拠として新規に採用しない。
- **理由**: ユーザー要求「ローカル実行であることだけを全面信頼の根拠にしない」に対応。既存の`ctx.remote===false`の挙動そのものを今回変更する提案ではない(ユーザーが明示的に「ローカルCLIを直ちにOAuth化する提案は不要」としているため)。
- **違反例**: 将来新設する操作Xについて、「ローカルなら無条件許可、リモートならスコープ確認」という新規の分岐を追加すること。
- **検証方法**: 新規操作の認可条件に`ctx.remote === false`単独を根拠とする新しいバイパスが追加されていないかをコードレビューで確認する。
- **対応テスト候補**: 新規追加される操作について、ローカル/リモートを問わず同一のCapability判定ロジックが通ることを確認するテスト(新機能追加時のレビューチェックリスト項目として運用)。

## AUTHZ-INV-012: Client登録はPrincipalの信頼登録を意味しない

- **規則**: DCR(Dynamic Client Registration)や管理画面からのClient登録は、Clientレコードを作成するのみであり、それによって自動的にPrincipalが「信頼済み」になるわけではない。
- **理由**: `PHASE9A-IDENTITY-MODEL-DECISION.md`§3で確定した設計(`principal_id`は既定でnull)を裏付ける不変条件。
- **違反例**: Client登録の瞬間に、そのClientに紐づく想定のPrincipalへ自動的に高い信頼レベル(例: admin相当)を付与する実装。
- **検証方法**: 新規登録直後のClientの`principal_id`が既定でnullであり、Capability(scope)はあくまで登録時に明示指定された値のみであることを確認する。
- **対応テスト候補**: 新規Client登録直後に、そのClientのPrincipal関連付けが存在しないことと、scopeが登録リクエストで明示指定した値以外に拡張されていないことを確認するテスト(Phase 9B実装時に追加)。

## AUTHZ-INV-013: 監査イベントは成功・拒否・失敗のいずれも記録され、欠落は明示的に検知可能である

- **規則**: 認可判断の結果(成功・拒否・失敗)は、いずれも何らかの監査記録として残す。ある経路が監査記録を欠いている場合、それは意図的な設計として明示的に文書化され、偶発的な見落としとして放置されない。
- **理由**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`§3で確認した通り、現状`/ingest`の拒否・失敗系統、`submit_agent`の拒否試行、管理画面操作、GitHub Webhook全体、CLI全体が監査記録を欠いている。これらは今回明示的に文書化されたが(本条件が満たすべき最低ライン)、恒久的に放置してよいという意味ではなく、Phase 9C以降で解消候補として扱う。
- **違反例**: 新機能を追加した際、成功パスだけログを書き、拒否・エラーパスにログ呼び出し自体が存在しない実装(現行の`/ingest`と同じパターン)。
- **検証方法**: 新規・既存の全エントリポイントについて、成功・拒否・失敗それぞれの分岐にログ書き込み呼び出しが存在するかをコードレビューでチェックする。
- **対応テスト候補**: 各エントリポイント(MCP/HTTP/CLI/管理画面/Webhook)について、意図的に拒否・失敗を発生させ、期待される監査記録(または「記録されない」という明示的な仕様)と一致することを確認するテスト。

## AUTHZ-INV-014: Credentialは権限を内包せず、検証の証拠としてのみ機能する

- **規則**: Credential(トークン・シークレット)自体はCapability集合を埋め込まない。権限はPolicy Decision時に、検証済みCredentialが指し示すClient/Principalの現在の状態を都度参照して解決する。
- **理由**: `PHASE9A-IDENTITY-MODEL-DECISION.md`§4で確認した通り、これは既存の`oauth_tokens`の健全な設計を追認するものであり、新規制約ではない。
- **違反例**: トークン発行時にスコープをトークン自体にエンコードし、後からClientのscopeを変更してもトークンには反映されない(revokeしない限り古いスコープのまま通ってしまう)実装。
- **検証方法**: Clientのscopeを変更した場合、既存の有効なトークンでも次回リクエスト時に新しいscopeが即座に反映されることを確認する。
- **対応テスト候補**: 発行済みトークンが有効なまま、Client側のscopeを縮小した場合、次のリクエストで縮小後のscopeが適用されることを確認する回帰テスト。

## AUTHZ-INV-015: 新しい主体種別・プロトコル・製品の追加は認可コアのコード分岐を必要としない

- **規則**: 新しいPrincipal種別、新しい接続プロトコル、新しい製品(クライアント実装)を追加する際、`scope.ts`・`hasScope()`・`operations.ts`の認可判定ロジックに新規のif分岐を追加する必要があってはならない。
- **理由**: `PHASE9A-CURRENT-STATE-AUDIT.md`のUniversal化判定項目2・7で確認した通り、これは既に達成されている性質(PASS)。今後の変更でこの性質を壊さないための固定。
- **違反例**: 新しいクライアント「Gemini CLI」対応のために、`operations.ts`に`if (clientName === 'gemini-cli') { ... }`を追加すること(`connect.ts`のような利便ヘルパーへの追記は対象外、認可コア本体への追記が違反)。
- **検証方法**: 新規クライアント・新規プロトコル対応のPRにおいて、`scope.ts`/`operations.ts`の認可判定部分に差分がないことを確認する。
- **対応テスト候補**: 新規クライアント登録(既存の登録手順のみ使用)後、追加の認可コア変更なしにそのクライアントが期待通り動作することを確認する統合テスト(Phase 8で既に実施済みの3クライアント登録テストの手法を踏襲)。

## AUTHZ-INV-016: 委任境界の未grantは、暗黙の広い既定へフォールバックしない(2026-08-03新設)

- **規則**: 委任元に特定の名前空間のgrantが存在しない場合(`bound_slug_prefixes`がNULLまたは空、`bound_source_id`が未設定)、委任先はその軸について「制限なし」にも「実装依存の既定名前空間」にもならない。未grantの帰結は、明示的に文書化された単一の値でなければならない。
- **`allowed_slug_prefixes`の3状態の正式な意味(2026-08-03ユーザー承認・案4)**: `bound_slug_prefixes`について、
  1. NULLまたは未指定 = 書き込み名前空間が**未grant**
  2. 明示空配列`[]` = NULLと**意味的に同一**(未grant)。新規登録・新規書き込み時はNULLへ正規化する。既存行の`[]`は読み取り時にNULLとして扱う(`token_endpoint_auth_method`が既に確立している「読み取り寛容・書き込み厳格」パターンと同型)
  3. 1件以上の配列 = 委任可能な書き込み名前空間の集合(唯一の明示的grant表現)

  **NULLは「制限なし」を意味しない**(`dashboard-5krlu`修正の中核)。既存データに対するmigration/backfillは行わない — 上記の意味は読み取り側の解釈規則であり、既存行の値そのものは変更しない。
- **理由**: 現状NULLと`[]`は`submit_agent`の拒否`reason_code`のみが異なり(`no_slug_prefix_binding` vs `slug_prefix_not_bound`)、意味論として区別されていない。区別されていない2値を将来別々の意味に割り当てると、既存行の意味が遡って変わる。加えて、OAuthクライアント登録経路のうちDCR・管理画面・`gbrain connect --register`は`bound_*`列を構造的に設定できずNULL固定であるため、NULLを「制限なし」と解釈すると、それらの経路で登録されたクライアントに無制限の委任書き込みを与えることになる。
- **違反例**: 未grantを「制限なし」と解釈する実装(`dashboard-5krlu`修正前の挙動)。
- **検証方法**: `bound_slug_prefixes`がNULL・`[]`・非空の3パターン × `allowed_slug_prefixes`を要求した/しなかったの計6通りの結果が、本条件が定める意味と一致することを確認する。
- **既知の未充足(Phase 9E-2で是正予定)**: 未grant時の委任ジョブは現在`wiki/agents/<jobId>/`というレガシーsandboxへ書き込める(`src/core/operations.ts`の`enforceSubagentSlugFence`)。これは「実装依存の既定名前空間」であり本条件の趣旨に反するが、`submit_agent`以外のsubagent経路(cycle等)と共有された既存挙動であるため、**Phase 9E-1では変更せず**、Phase 9E-2でopt-inのfail-closedモードとして是正する。

## AUTHZ-INV-017: 委任開始の権限と、委任される能力の保有は別々に検証される(2026-08-03新設)

- **規則**: あるClientが委任(`submit_agent`相当)を開始してよいかどうかと、その委任で子へ渡す各能力を委任元自身が保持しているかどうかは、独立に検証する。`agent`スコープは前者(委任開始権)のみを表し、後者(対象能力の保有)を含意しない。子へ渡す操作Xがrequired scope Sを持つなら、委任元は`hasScope(委任元のscopes, S)`を満たさなければならない(2026-08-03ユーザー承認・案B)。
- **理由**: `src/core/scope.ts`の`IMPLIES`テーブルにより`agent`は他のどのスコープも含意せず、`admin`も`agent`を含意しない。したがって現状`--scopes agent`のみのClientは自分では`put_page`(write)も`query`(read)も呼べないが、`bound_tools`に含まれていれば子ジョブにそれらを実行させられる(`src/core/minions/tools/brain-allowlist.ts`の`execute`、子のツール実行は`authorizeOperation()`を経由しない)。これは委任元が保持しない権限が委任経由で行使されるconfused deputy構造であり、AUTHZ-INV-005の趣旨に反する。
- **違反例**: `scope='agent'`のみのClientが`allowed_tools: ['put_page']`で委任し、子が書き込みに成功する。
- **検証方法**: `scope='agent'`のみのClientがwrite系ツールを含む委任を要求した場合の挙動が、下記の段階移行表と一致することを確認する。
- **段階移行(既存クライアントを即座に壊さないため)**:

  | フェーズ | 挙動 |
  |---|---|
  | Phase 9E-1 | **warn-only**。`scope='agent'`のみのClientがrequired scope不足のツールを委任しても許可はされるが、`audit_events`に`decision='allowed'`かつ`reason_code='delegation_scope_shortfall'`を記録する |
  | Phase 9E-2 | **enforce**。同条件で`permission_denied`により拒否する |

  OAuthのワイヤ表現(`scopes_supported`)は変更しない — 新しいスコープ値を追加せず、既存の`read`/`write`を追加で要求するのみである。
- **対応テスト候補**: Phase 9E-1では、`scope='agent'`のみ+`bound_tools`にwrite系ツールを含むClientが委任した際、監査に`delegation_scope_shortfall`が記録されることを確認するテスト。Phase 9E-2では、同条件が`permission_denied`になることを確認する回帰テスト。

---

## 補足: Principal失効とこれらの不変条件の関係(フェーズ適用範囲の明示)

本書の不変条件は「Phase 9B以降の実装が守るべき」将来にわたる目標であり、Phase 9B単体の実装がこれら全てを直ちに満たすことを要求するものではない。特にPrincipal失効(`revoked_at`)については、`PHASE9A-IDENTITY-MODEL-DECISION.md`§1-1bで確定した通り、**Phase 9BではPrincipal失効はClient認証・トークン有効性・scope認可のいずれにも影響しない**(帰属情報のみ)。AUTHZ-INV-002・006・007が想定する「失効状態からの権限導出」「委任元失効の伝播」は、Principal失効がPolicy Decisionに接続されるPhase 9D以降で初めて本格的に適用される。Phase 9B時点でこれらの条件がPrincipal失効に関して未充足であることは、既知・意図した段階的適用であり、矛盾ではない。
