# Phase 9E — Delegation汎用化 実装スコープ

**日付**: 2026-08-03
**位置づけ**: `PHASE9E-DELEGATION-DOMAIN-MODEL.md`で定義した概念を、実際にどう・どこまで実装するかを規定する。本書はPhase 9E-1(挙動保存)の実装スコープを主対象とし、Phase 9E-2(機能有効化)は方向性のみ記載する(9E-2自体の詳細スコープは9E-1完了後に別途確定する)。

---

## 1. 対象判定の中核原則

Phase 9E-1は**挙動保存を原則とする**。「挙動保存」とは、既存のsubmit_agent関連テスト(`test/submit-agent.test.ts`・`test/operations-allow-list.test.ts`・`test/audit-delegation-chain.test.ts`)の既存アサーション・期待値・許可/拒否の期待結果を変更しないことを指す(2026-08-03修正 — Phase 9E-1 Final Audit指摘反映)。新規テストの追加、および後方互換なテストヘルパーの拡張は許容する。既存テストケースが同一の期待値のまま全件パスすることで挙動保存を証明する。新しい型・関数を導入し既存ロジックをその型で表現し直すが、外部から観測可能な認可結果は変えない。

例外的に許容する「観測可能な変更」は以下の2点のみ(いずれもAUTHZ-INV-016の段階移行として承認済み):
1. `--bound-slug-prefixes ""` のような事故入力が、黙って`[]`として登録される代わりに明示エラーになる。
2. `agent` scope保有かつ`bound_tools`が非NULLで、かつ委任対象ツールのrequired scopeを保有しないクライアントについて、`audit_events`に新規`reason_code='delegation_scope_shortfall'`が記録されるようになる(**warn-only**、拒否はしない)。

---

## 2. 対象に含める作業(IN)

### 2-1. 正本改訂・設計文書(実施済み、本タスクの成果物)

- `PHASE9A-AUTHORIZATION-INVARIANTS.md`: AUTHZ-INV-005改訂、AUTHZ-INV-016・017新設。
- `PHASE9E-DELEGATION-DOMAIN-MODEL.md`: 新規作成。
- 本書。

### 2-2. Phase 9E-1で実装する内容(未着手、次段階)

1. **Capability/Delegation Constraint型の導入**: `src/core/`配下に、`PHASE9E-DELEGATION-DOMAIN-MODEL.md`§1・§2で定義した型(操作集合×名前空間、Constraint)を表現する型定義を追加。
2. **`submit_agent`の既存検証をこの型で表現し直す**: `isRequestedSlugPrefixWithinBound`等の既存ロジックをCapability包含判定として再構成する、**挙動不変のリファクタ**。
3. **AUTHZ-INV-016の段階1・2実装**:
   - 新規登録・新規委任要求で`allowed_slug_prefixes: []`→NULL正規化。
   - CLI `gbrain auth register-client --bound-slug-prefixes ""` を明示エラーにする。
   - `gbrain doctor`または管理画面に、`agent` scope保有かつ`bound_tools`に書き込み系ツール(`scope==='write'`のツール)が含まれるかつslug grant(`bound_slug_prefixes`)が存在しないクライアントを警告表示する項目を追加(`src/commands/serve-http.ts`の既存の類似条件式を再利用)。読み取り専用ツールのみを束縛するクライアントは書き込み名前空間を一切行使できないため、slug grant不在を誤警告の対象にしない(2026-08-03修正 — Phase 9E-1 Final Audit指摘反映。実装は`checkDelegationCapabilityHealth`の`write_tool_without_slug_grant`検出として`src/commands/doctor.ts`に実在)。
4. **AUTHZ-INV-017のwarn-only判定**: `submit_agent`のハンドラで、委任対象ツールのrequired scopeを委任元Clientが保有しているかを判定し、不足時は`audit_events`に`reason_code='delegation_scope_shortfall'`(`decision='allowed'`のまま)を記録する。**拒否は行わない**。

### 2-3. Phase 9E-1に含めない内容(9E-2以降・意図的な設計判断)

- 孫委任の実際の有効化(multi-hop delegation) — **既定OFF**。有効化する仕組み自体を導入しない。
- AUTHZ-INV-017のenforce切替(拒否化)。
- AUTHZ-INV-016のレガシーsandbox opt-out(fail-closed)モード。
- `bound_source_id`未設定時の`'default'`フォールバック是正(`dashboard-z7a1o`) — 挙動変更を伴うため9E-2。
- 子ジョブ実行経路への`authorizeOperation()`導入(AUTHZ-INV-010の委任経路への適用) — 影響範囲が広く9E-2。**Phase 9E-2dで実装済み(dashboard-2i56j, 2026-08-05)**: `src/core/minions/tools/brain-allowlist.ts`の`execute()`が、`submit_agent`委任ジョブ(`ownerClientId`設定時)に限り、委任元Clientの現在scopeをDB再解決した上で既存の`hasScope`/`authorizeOperation()`(変更なし、そのまま再利用)を通す。詳細は`PHASE9A-AUTHORIZATION-INVARIANTS.md`のAUTHZ-INV-005/010を参照。多段委任・孫委任・AUTHZ-INV-017のenforce切替はこのフェーズでも未実施のまま。
- 隣接発見6件(`dashboard-7nqk9`・`dashboard-037qj`・`dashboard-1etlb`・`dashboard-z7a1o`・`dashboard-yug65`・`dashboard-vpfmz`)の実装 — Phase 9E設計とは独立、または9E-2対応。今回の文書確定作業では一切のコード修正を行わない。

### 2-4. Phase 9E-1完了後に追加した9E-2準備作業(`dashboard-v3mjk`、2026-08-03)

Phase 9E-1自体の完了条件(§1)には含まれないが、9E-2着手可否の判断材料として、Phase 9E-1完了後に以下を追加実装した。**これはenforce化そのものではない**(AUTHZ-INV-017は引き続きwarn-onlyのまま、拒否挙動の変更は一切なし)。

- `gbrain audit delegation-scope-shortfalls`(`src/commands/audit.ts` + `src/core/audit/delegation-scope-shortfall-report.ts`新規): `delegation_scope_shortfall`監査イベントをクライアント単位で集計し、AUTHZ-INV-017をenforceへ切り替えた場合に実際に拒否対象となるクライアントを事前に特定できるようにする読み取り専用CLI。時間範囲・client_id・source_id絞り込み、JSON出力に対応。

---

## 3. 変更対象ファイル(Phase 9E-1実装時、予定)

| ファイル | 変更概要 |
|---|---|
| `src/core/operations.ts` | `submit_agent`のCapability型リファクタ、AUTHZ-INV-017 warn-only判定追加 |
| `src/core/scope.ts` | 変更なし(既存`hasScope`/`authorizeOperation`をそのまま再利用) |
| `src/commands/auth.ts` | `--bound-slug-prefixes ""`の明示エラー化 |
| `src/commands/doctor.ts` | `agent`+書き込み系`bound_tools`あり+`bound_slug_prefixes`NULLクライアントの警告表示(読み取り専用ツールのみのクライアントは対象外) |
| `test/submit-agent.test.ts` | Capability型リファクタ後も既存ケースの期待値が一件も変わらず通ることを確認(回帰)。新規テスト追加は許容。新規: `delegation_scope_shortfall`記録テスト |
| `test/operations-allow-list.test.ts` | 回帰確認(既存ケースの期待値が変わらず通ること自体が受入条件。新規テスト追加は許容) |
| `test/audit-delegation-chain.test.ts` | 新規: `delegation_scope_shortfall`のreason_code識別性テスト |
| `CHANGELOG.md` | `[Unreleased]`セクションへ追記 |

**注記**: 上表は実装着手時の見込みであり、本書自体はこれらのファイルを変更していない(設計文書確定作業のみ)。

---

## 4. テスト計画(Phase 9E-1実装時、予定)

1. **回帰(最重要)**: `test/submit-agent.test.ts`・`test/operations-allow-list.test.ts`・`test/audit-delegation-chain.test.ts`の既存ケースが型リファクタ後も同一の期待値のままパスすること(既存アサーション・許可/拒否の期待結果は変更しない。新規テストの追加、後方互換なテストヘルパー拡張は許容)。これが「挙動保存」の機械的証明。
2. **Red→Green**: `[]`→NULL正規化、CLI事故入力エラー化、`delegation_scope_shortfall`記録の3点それぞれについてRedテストを先に書き、実装後Greenを確認する。
3. **不変条件テスト**: AUTHZ-INV-005の新定義(操作集合×名前空間)に対する組合せテストを、`dashboard-5krlu`で導入したAUTHZ-INV-005の property-based テストパターンを踏襲して追加。
4. **静的検査**: `bun run typecheck`、`bun run check:all`(既知のpre-existing無関係違反2件を除く)。

---

## 5. ロールバック方針(Phase 9E-1実装時、予定)

- **正本改訂(本タスク)**: `git revert`で完結。AUTHZ-INV-005・016・017はいずれも文書のみで、コード・スキーマへの影響はゼロ。
- **9E-1実装**: スキーマ変更を伴わないため`git revert`で完結。`delegation_scope_shortfall`の監査記録追加は新規`reason_code`の導入のみで、既存の`audit_event_kinds`/`audit_attribution_states`登録表への変更も不要(reason_codeはコード側自由文字列)。
- **feature flag**: 導入しない(`dashboard-5krlu`のロールバック方針と同じ判断根拠 — セキュリティ/認可挙動を無効化できるスイッチ自体が新たな攻撃面になる)。

---

## 6. migration/backfill不要の根拠

Phase 9E-1で実装予定の変更はいずれもスキーマ変更を伴わない:

1. **Capability/Delegation Constraint型**: TypeScript側の型定義のみ。DBスキーマは既存の`oauth_clients.bound_*`列をそのまま使う。
2. **AUTHZ-INV-016(`[]`→NULL正規化)**: **読み取り時の解釈規則**であり、既存行への書き換え(UPDATE)は行わない。新規登録・新規委任要求のみが正規化の対象。既存の`bound_slug_prefixes = '{}'`の行は、コード側が読み取り時に「NULLと同義」として扱うことで意味的に統一される — SQLレベルでのbackfillは不要かつ意図的に行わない(`audit_events`が事後推測backfillを一切行わない、というPhase 9Cの確定方針を踏襲)。
3. **AUTHZ-INV-017 warn-only判定**: `audit_events.reason_code`は既存のTEXT型自由文字列列であり、新しい値を書き込むだけで列追加・登録表への行追加は不要。

**結論**: Phase 9E-1の実装スコープ内で、スキーマ変更・マイグレーション・データbackfillはいずれも発生しない。

---

## 7. 既存クライアント互換性

| 変更 | 影響 |
|---|---|
| Capability型リファクタ | ゼロ(内部表現の変更のみ、外部挙動は不変) |
| `[]`→NULL正規化(新規のみ) | ゼロ(既存クライアントの登録済み値は書き換えない) |
| CLI事故入力の明示エラー化 | ほぼゼロ(意図的な空文字列渡しは通常発生しない操作) |
| `delegation_scope_shortfall`のwarn-only記録 | ゼロ(拒否しない、監査記録が増えるのみ) |

**破壊的変更なし**。Phase 9E-1完了時点で、既存のOAuthクライアント・subagent呼び出しパターンはすべて従来通り動作する。

---

## 8. 参照元

- `PHASE9E-DELEGATION-DOMAIN-MODEL.md`
- `PHASE9A-AUTHORIZATION-INVARIANTS.md`(AUTHZ-INV-005・016・017)
- `PHASE9A-GAP-AND-ROADMAP.md`§7
- Beads: `dashboard-qj0ir`(Phase 9E親タスク、OPEN)
