# Phase 9E — Delegation ドメインモデル

**日付**: 2026-08-03
**位置づけ**: Phase 9E(Delegation汎用化・孫委任)が実装する概念とその責務を定義する。`PHASE9A-TARGET-DOMAIN-MODEL.md`§6(Delegation)・§7(Capability/Permission)の上位に位置し、`PHASE9A-AUTHORIZATION-INVARIANTS.md`のAUTHZ-INV-005(2026-08-03改訂)・016・017(2026-08-03新設)の実装仕様を提供する。本書自体は実装ではなく、実装が満たすべき構造の定義である。

> **確定の経緯**: Beads `dashboard-5krlu`(narrowing fail-open修正)の調査過程で発見された隣接課題4件(`dashboard-2quyv`・`dashboard-alz2w`・`dashboard-444rs`・`dashboard-tje5b`)をOpusが単独レビューし、「Phase 9E着手前に必須なのはコード修正ではなく3件の設計決議」と判定した。続くOpus単独レビューで正式決議案(AUTHZ-INV-005修正・016・017新設)を作成し、2026-08-03にユーザーが承認した。本書はその承認内容をドメインモデルとして体系化したものである。

---

## 0. 前提: 2026-08-03付でユーザーが確定した事項

1. **Capabilityの正式定義**: 案2「ツール集合×名前空間」を採用。budget・期限・並列度・委任深度等はCapability本体ではなくDelegation Constraintとして分離する。
2. **`allowed_slug_prefixes`の3状態**: 案4を採用。NULLまたは未指定は「未grant」、明示空配列`[]`も意味的には未grantと同一、新規書き込み時は正規化する。非空配列のみを明示的なslug grantとして扱う。既存データは読み取り互換を維持し、migration/backfillは行わない。
3. **`scope='agent'`と委任可能Capability**: 案Bを採用。`agent` scopeは委任開始権のみを表す。子ジョブへ渡す各ツールのrequired scopeを親クライアントも保有していることを要求する。既存クライアントへの影響を避けるため、Phase 9E-1ではwarn-only、Phase 9E-2でenforceへ切り替える。OAuth 2.1ワイヤ変更は行わない。

これら3点は`PHASE9A-AUTHORIZATION-INVARIANTS.md`のAUTHZ-INV-005・016・017として正本に反映済み。本書はその実装上の意味を詳細化する。

---

## 1. Capability

**定義**: `(操作集合 × 名前空間)` の組。

- **操作集合**: `bound_tools ∩ BRAIN_TOOL_ALLOWLIST ∩ allowed_tools`(要求側)。既存の`submit_agent`実装がそのまま体現する。
- **名前空間**: `(direction, source_id, slug_prefix_set)` の3つ組。`direction ∈ {read, write}`。
  - **書き込み名前空間** = `bound_source_id` × `bound_slug_prefixes`。委任先が書き込んでよい対象を規定する。
  - **読み取り名前空間** = `source_id` / `federated_read`。委任先が読んでよい対象を規定する。**現状、読み取り側にslug prefix軸は存在しない**(`dashboard-444rs`で確認済み、`docs/designs/COMMUNITY_IDEAS.md`§6の既知上流課題)。Phase 9Eはこの非対称を解消しない — dream cycleの synthesize/patterns が「brain全体を読んで限定範囲に書く」構造に依存しているため、読み取り軸を書き込みと同様に絞ると中核機能が機能停止する(`dashboard-444rs`調査で確認済み)。この非対称は本書により**意図的仕様として正式に決議**する。

Capabilityでない属性(Delegation Constraintとして分離、§2参照): `budget_usd_per_day`・`bound_max_concurrent`・credential expiry・delegation depth。

**Capabilityの部分集合判定**: 操作集合は包含(⊆)、名前空間はdirectionごとの包含で判定する。書き込み名前空間の包含判定は`isRequestedSlugPrefixWithinBound()`(`src/core/operations.ts`、`dashboard-5krlu`で新設)がスラッシュ境界を考慮して行う。

---

## 2. Delegation Constraint

Capabilityとは別カテゴリとして扱う理由: 集合の包含(⊆)と数値の順序(≤)は異なる証明技法を要求し、同じ「部分集合」の語で扱うと実装・検証の両方が曖昧になる。

| Constraint | 単調性の方向 | 現在の強制状況 |
|---|---|---|
| `budget_usd_per_day` | 子の日次上限 ≤ 親の日次上限 | **未確認**(`budget-meter.ts`の本番呼び出し元が`src/`配下に見当たらない、`dashboard-037qj`で追跡) |
| `bound_max_concurrent` | 子のサブツリー全体の同時実行数 ≤ 親の上限 | 実装済み(`operations.ts`のconcurrency cap検証、ただし`__owner_client_id`ベースの数え方が偶然サブツリー全体になっている) |
| credential expiry | 子の有効期限 ≤ 親の有効期限 | 未実装(Delegation自体がまだ一級市民でないため) |
| delegation depth | 子のdepth = 親のdepth + 1、かつ ≤ 親が許可した最大深度 | Phase 9E-2で導入(§4参照) |

**重要**: 実装済みでない属性(budget等)をCapabilityの部分集合判定に含めると、検証不能な不変条件を宣言することになる(`PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md`§2が「実体のない概念への先行FK列は追加しない」として`delegation_id`列を見送った判断と同じ理由)。Delegation Constraintとして分離することで、各属性の強制状況を独立に追跡・実装できる。

---

## 3. 親・子・孫ジョブ

- **親ジョブ**: OAuthクライアント(agent scope保有)が`submit_agent`で直接投入するジョブ。depth=0。
- **子ジョブ**: 親ジョブ内のsubagentが(Phase 9E-2で有効化される再委任ツールを通じて)投入するジョブ。depth=1。
- **孫ジョブ**: 子ジョブがさらに投入するジョブ。depth=2。以降同様。

現状(Phase 9E以前)、`submit_agent`は`queue.add()`に`parent_job_id`を渡さないため、常にdepth=0のトップレベルジョブのみが生成される(1階層限定の構造的原因)。加えて、subagentのツール登録リスト(`BRAIN_TOOL_ALLOWLIST`)に`submit_agent`自体が含まれないため、子ジョブから新たな委任を行う手段が現状存在しない。

**例外**: `submitSelfFixChild`(`src/core/minions/self-fix.ts`)は既にdepth=1相当の子ジョブを生成しており、親の`data`をスプレッドして権限をそのまま継承する。これは「エージェント起点の再委任」ではなく「システム起点の再委任」であり、Phase 9Aが「孫委任は不可能」と結論づけた対象(エージェントが自発的に行う再委任)とは異なる、既に本番稼働している経路である。Phase 9Eはこれを新機能ではなく**既存経路の正規化**として扱う。

**最大委任深度の正式決定(Phase 9E-2e-1, 2026-08-05)**: 最大委任深度は固定値**5**(`MAX_DELEGATION_DEPTH`、`src/core/delegation-capability.ts`)とする。root delegatorから直接生成されたchildをdelegation depth 1とし、depth 1→2→3→4→5まで許可、depth 5のジョブからの再委任は`delegation_depth_exceeded`で拒否する。外部設定化しない(`GBrainConfig`・環境変数・CLIオプション・OAuthクライアント設定のいずれにも追加しない)。**この委任深度(delegation depth)は、self-fixの`SelfFixOpts.max_depth`(既定2、self-fixリトライ連鎖専用のカウンタ)およびMinionQueueの汎用`maxSpawnDepth`(既定5、`parent_job_id`を持つ全ジョブに適用される汎用spawn深度)のいずれとも意味論的に別物であり、数値が5で一致するのは偶然である**。委任深度は将来のadapter実装がjob data内の専用マーカーで独自に管理する(self-fixの`data.is_self_fix_child`と同型のパターン)。

**再委任許可の正式決定(Phase 9E-2e-1)**: 再委任許可はAUTHZ-INV-008の要求通り明示的なgrantとし、現在ジョブの実効`allowed_tools`(root clientの生の`bound_tools`ではない)に、子ジョブ専用の委任adapterツール名(候補: `submit_agent_delegated`。通常の`submit_agent`とは明確に区別する)が完全一致で含まれる場合のみ許可する。専用のOAuth scope・専用のboolean属性は追加しない。

**Phase 9E-2e-1時点の実装状態**: `src/core/delegation-capability.ts`に`MAX_DELEGATION_DEPTH`定数、および`canRedelegate`/`nextDelegationDepth`/`validateRedelegatedCapability`/`validateRedelegatedConstraint`/`evaluateRedelegation`の5つの純関数(queue・DB・audit・OperationContextに一切依存しない)を追加した。**これらは判定ロジックの基盤のみであり、`submit_agent`または委任adapターはまだ`BRAIN_TOOL_ALLOWLIST`に追加されておらず、多段委任(孫委任)自体はまだ有効化されていない**。AUTHZ-INV-007(委任期限の継承)は本コミットでも未充足のまま残る — CapabilityおよびDelegationConstraintに期限フィールドは追加していない。

---

## 4. 権限継承・縮小(narrowing)

委任チェーン上の任意の辺 `parent → child` について、実効Capabilityは以下で算出する:

```
Effective(child) = Granted(child) ⊓ Effective(parent) ⊓ Live(root_client)   [depth > 0]
Effective(child) = Granted(child) ⊓ Live(root_client)                       [depth = 0]

各次元の ⊓ は:
  操作集合        : 集合積(さらに BRAIN_TOOL_ALLOWLIST とも積を取る)
  書き込み名前空間  : source_idの一致 かつ slug_prefixのスラッシュ境界包含
  読み取り名前空間  : source_idの一致(slug prefix軸は§1の通り対象外)
  depth           : child.depth = parent.depth + 1 かつ ≤ min(parent.max_depth, HARD_MAX)
  budget/expiry等  : min(...)(Delegation Constraintは単調性で判定)

Live(root_client) が空になる条件:
  oauth_clients.deleted_at IS NOT NULL
  または hasScope(oauth_clients.scope, 'agent') === false
  または委任チェーン上の任意の階層で失効・期限切れ
```

単調性は各次元が`⊓`(積・最小値)で定義されることから帰納的に従い、「親が持たない権限を子孫へ付与できない」は定理として成立する。

**未grant時の扱い(AUTHZ-INV-016)**: 親Delegationのgrantが空(NULLまたは`[]`、すなわちレガシーsandboxへのフォールバック)の場合、孫は**新規の名前空間を一切grantできない**(fail-closed)。理由: レガシーsandboxはジョブID依存の名前空間であり、孫は別のジョブIDを持つため、包含関係が定義上成立しない。

---

## 5. Scope判定(AUTHZ-INV-017)

- **委任開始権**: `agent` scope。`submit_agent`を呼べるかどうかのみを決める。
- **委任対象能力の保有**: 子へ渡す各操作のrequired scopeを、委任元Client自身が保有していることを要求する(`hasScope(委任元のscopes, 操作のrequired_scope)`)。
- **この2つは独立に検証される**。`agent`スコープは`read`/`write`/`admin`のいずれも含意しない(`src/core/scope.ts`の`IMPLIES`テーブル)。

**段階移行**:

| フェーズ | 挙動 |
|---|---|
| Phase 9E-1 | warn-only。required scope不足のまま委任は許可されるが、`audit_events`に`reason_code='delegation_scope_shortfall'`で記録 |
| Phase 9E-2 | enforce。同条件を`permission_denied`で拒否 |

OAuth 2.1のワイヤ表現(`scopes_supported`、DCR、トークン発行)は変更しない。新しいscope値は追加しない。

---

## 6. 失効・期限

- **委任元Clientの失効**(`deleted_at`設定・`revoke-client`): 実行中・待機中の委任先ジョブは、次の権限行使のタイミングで失効を検知し停止する。即時強制終了は保証しない(HTTP呼び出し中の即死は不可能)。
- **Credentialの失効**(トークン削除のみ、Client自体は生存): 委任は生存する。権限の源泉はCredentialではなくClientのbinding(AUTHZ-INV-014)であるため。
- **委任の明示的取消**: Phase 9E-2でDelegationが一級市民化された場合に導入。取消時は子孫を含めて停止する。
- **親ジョブの終了**: 委任の権限寿命と実行寿命は分離する。親ジョブがcompletedになっても、その前に発行された子の委任は独自の有効期限まで有効(ただし親Delegation自体が失効・期限切れなら子孫も直ちに無効)。

---

## 7. 監査イベント

- `delegation.grant` / `delegation.deny`: 既存(`audit_event_kinds`にPhase 9Cでシード済み)。
- 付与内容(`allowed_tools`・`allowed_slug_prefixes`)の記録は現状欠落している(`dashboard-tje5b`)。本書は記録要否そのものを決議しない — `dashboard-tje5b`として引き続き独立追跡する。
- `reason_code='delegation_scope_shortfall'`: AUTHZ-INV-017のwarn-only期間に新設(§5)。
- `reason_code='no_slug_prefix_binding'` / `'slug_prefix_not_bound'` / `'invalid_slug_prefix_binding'` / `'invalid_slug_prefix_requested'`: 既存(`dashboard-5krlu`で新設済み)。

---

## 8. fail-closed条件(まとめ)

以下はいずれも許可ではなく拒否側に倒す:

1. 要求prefixが存在するのに`bound_slug_prefixes`がNULL(`dashboard-5krlu`で対応済み)。
2. bound/requestedいずれかに空文字列・非文字列・不正値が含まれる(`dashboard-5krlu`で対応済み)。
3. 委任チェーンが解決できない場合(行欠損、親削除、深度超過、循環検出) — Phase 9E-2でDelegationが一級市民化された際の設計方針として記録。「解決できないので前回値を使う」「解決できないので通す」は禁止。
4. 親のgrantが空(未grant)の状態から孫へ新規名前空間をgrantしようとする(§4)。
5. (Phase 9E-2以降)required scope不足での委任(§5)。

---

## 9. Phase 9E-1と9E-2の境界

| | Phase 9E-1 | Phase 9E-2 |
|---|---|---|
| 原則 | **挙動保存**。既存のCapability・narrowing判定を本書の型で表現し直すリファクタ | 新機能の有効化 |
| AUTHZ-INV-005 | 定義の明文化(正本改訂のみ、済) | `bound_source_id`未設定時の`'default'`フォールバック是正(`dashboard-z7a1o`) |
| AUTHZ-INV-016 | `[]`→NULL正規化、CLI事故入力の明示エラー化、doctor/管理画面での`agent`+`bound_tools`NULL警告 | レガシーsandboxのopt-out(fail-closed)モード導入 |
| AUTHZ-INV-017 | **warn-only**判定(`delegation_scope_shortfall`監査記録) | **enforce**へ切替 |
| 多段委任(孫委任) | **既定OFF**。`bound_max_delegation_depth`相当は導入しない、または導入しても既定0 | 明示的に有効化されたクライアントのみ孫委任可能 |
| 子ジョブのPolicy Decision経由 | 未対応のまま(既知の未充足として文書化) | `authorizeOperation()`経由への統一(AUTHZ-INV-010の委任経路への適用) |
| スキーマ変更 | 不要 | 必要な場合は別途マイグレーション文書を作成 |

**9E-1完了の判定基準**(2026-08-03修正 — Phase 9E-1 Final Audit指摘反映): 既存のsubmit_agent関連テスト(`test/submit-agent.test.ts`・`test/operations-allow-list.test.ts`・`test/audit-delegation-chain.test.ts`)の既存アサーション・期待値・許可/拒否の期待結果を変更しないこと。新規テストの追加、および後方互換なテストヘルパーの拡張(既存呼び出し側の挙動を変えない型の緩和等)は許容する。既存テストケースが同一の期待値のまま全件パスすることをもって挙動保存の機械的証明とする(=「1ファイルも差分ゼロ」という字面ではなく「既存の期待値が一つも変わらない」ことが基準)。

---

## 10. 参照元

- `PHASE9A-AUTHORIZATION-INVARIANTS.md` — AUTHZ-INV-005(改訂)・016・017(新設)
- `PHASE9A-TARGET-DOMAIN-MODEL.md` — §6 Delegation・§7 Capability/Permission
- `PHASE9A-GAP-AND-ROADMAP.md` — §7 Phase 9E定義
- `PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md` — §2(delegation_id列見送りの先例)
- `docs/designs/COMMUNITY_IDEAS.md` — §6(読み取り側slug prefix未強制の既知上流課題)
- Beads: `dashboard-qj0ir`(Phase 9E親タスク)・`dashboard-5krlu`(narrowing fail-open、CLOSED)・`dashboard-2quyv`/`dashboard-alz2w`/`dashboard-444rs`/`dashboard-tje5b`(隣接発見)・`dashboard-z7a1o`/`dashboard-1etlb`/`dashboard-037qj`/`dashboard-yug65`/`dashboard-7nqk9`/`dashboard-vpfmz`(2026-08-03追加の隣接発見)
