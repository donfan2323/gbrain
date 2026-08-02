# Phase 9A — 証跡マニフェスト(調査ファイル・実行コマンド・未確認事項・8文書の優先順位)

**日付**: 2026-07-31(初版) / 2026-08-01(補完監査後の最終状態)
**目的**: Phase 9A全体(初版4文書+補完監査4文書、計8文書)の記述のうち、どれが確認済みの事実で、どれが推測・提案であるかを分離して記録する。実行モデルはSonnet固定、サブエージェントは使用していない(ユーザー指示どおり)。

## 0. 改訂履歴

- **集計誤りの修正(2026-07-31)**: `PHASE9A-CURRENT-STATE-AUDIT.md`のUniversal化10項目判定の集計サマリー文が「PASS 4 / PARTIAL 4 / FAIL 3」(合計11)と誤記されていた(正しくはPARTIAL 3、合計10)。表本体(項目1〜10)自体は当初から正しかった。訂正済み。
- **配置場所の変更(2026-07-31)**: 初版4文書を一時領域から`/Users/lab/AI_Workspace/gbrain/`リポジトリ直下へ新規ファイルとして配置。
- **補完監査の実施(2026-08-01)**: `PHASE9A-SUPPLEMENTAL-AUDIT.md`・`PHASE9A-IDENTITY-MODEL-DECISION.md`・`PHASE9A-AUTHORIZATION-INVARIANTS.md`・`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`の4文書を新規作成。既存4文書のうち、事実誤認・集計誤り・相互矛盾に該当する箇所を最小限修正。
- **認証機構の分類確定(2026-08-01)**: GitHub Webhook HMAC署名を、主体認証(3系統)とは別カテゴリの「メッセージ真正性検証」として分類することを確定。3系統というカウント自体は変更していない(詳細は`PHASE9A-CURRENT-STATE-AUDIT.md`§2「認証機構の分類」)。
- **Subject不採用の全文書反映(2026-08-01)**: `PHASE9A-IDENTITY-MODEL-DECISION.md`でのSubject不採用決定を、`PHASE9A-TARGET-DOMAIN-MODEL.md`(概念一覧から削除・10概念に再整理)・`PHASE9A-GAP-AND-ROADMAP.md`(独立ギャップとして扱わない旨に更新)・`PHASE9A-CURRENT-STATE-AUDIT.md`(評価文言を参照形式に修正)へ反映。
- **Principal種別保存方式・失効意味・Phase 9B範囲の確定(2026-08-01)**: `principal_kinds`登録テーブル方式(A/B/C/D比較の結果、C案採用)、Phase 9BでのPrincipal失効は認可挙動に影響しない旨、Phase 9Bは案A(基盤のみ)採用、を`PHASE9A-IDENTITY-MODEL-DECISION.md`・`PHASE9A-AUTHORIZATION-INVARIANTS.md`・`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`の3文書に一致させて反映。

---

## 1. 調査したファイル一覧

### 1-1. 初版(2026-07-31)で確認したファイル

| ファイル | 行数 | 確認内容 |
|---|---|---|
| `src/core/scope.ts` | 193行(全読) | スコープ階層、`hasScope`、`IMPLIES`テーブル、`normalizeScopesInput` |
| `src/core/types.ts` | 1671行(grep+部分読) | 主体系型の不在確認(Page/Chunk/Link等の知識ドメイン型のみ) |
| `src/core/oauth-provider.ts` | 1100行(1-200行読、他grep) | `AgentClientBindings`, `TokenEndpointAuthMethod`, `GBrainOAuthProviderOptions`, `validateRedirectUri`, CLI registration bypassコメント(133行付近) |
| `src/core/operations.ts` | 抜粋読(264-313行, 3038-3192行) | `AuthInfo`型全文、`submit_agent`オペレーション全文 |
| `src/schema.sql` | 1443行(43 CREATE TABLE全grep、581-730行・873-1077行読) | `ingest_log`, `config`, `access_tokens`, `mcp_request_log`, `oauth_clients`, `oauth_tokens`, `oauth_codes`, `op_checkpoints`, `minion_jobs`, `minion_inbox`, `minion_attachments`, `migration_impact_log`, `subagent_messages`, `subagent_tool_executions`, `subagent_rate_leases` |
| `src/commands/serve-http.ts` | 2630行(1364-1410行読、grep多数) | `requireAdmin`ミドルウェア、`/admin/api/sign-out-everywhere`、`/admin/api/agents`のtoken_name=client_id前提クエリ、`/mcp`・`/mcp-v2`・`/ingest`の`requireBearerAuth`共有配線 |
| `src/commands/connect.ts` | 768行(grep+50-67行, 396-437行読) | `AgentId`型、`AGENT_SPECS`、`buildConnectBlock`/`buildJson`の分岐 |
| `src/core/enrichment/budget.ts` | 抜粋(20-45行) | `ReserveInput.scope`のコスト管理用パーティションキーの性質確認 |
| `src/core/pglite-engine.ts`, `db-lock.ts`, `migrate.ts`, `connection-manager.ts`, `config.ts`, `db.ts` | grep | single-tenant明記箇所、tenant/organization参照なしの確認 |

### 1-2. 補完監査(2026-08-01)で追加確認したファイル

| ファイル | 確認内容 |
|---|---|
| `docs/adr/0001-single-binary-rejected.md` | 主体/認証と無関係な単一バイナリ配布ADR。矛盾なし |
| `docs/architecture/`全14件、`docs/mcp/`全8件 | grepによる用語検索(Principal/Subject/Identity/Actor/Tenant等)、該当なし |
| `docs/designs/MINIONS_AGENT_ORCHESTRATION.md` | 全文読了。「v1 single-user, single-brain」の既存決定、「Phase 3: Multi-tenant auth」の既存計画、`AgentJobData.platform`が未実装であることの根拠 |
| `admin/src/pages/Login.tsx`, `admin/src/api.ts` | 全文読了。単一bootstrap token・匿名operatorモデルの確認 |
| `admin/src/pages/RequestLog.tsx` | 冒頭部読了。`mcp_request_log`列をそのまま表示する構造の確認 |
| `src/commands/serve-http.ts`(全19 `/admin/api/*`ルート登録) | grepで全件確認。`requireAdmin`一本のみで保護、監査記録なしの確認 |
| `src/commands/serve-http.ts`(1900-2630行、`/mcp`・`/mcp-v2`・`/ingest`・`/webhooks/github`ハンドラ全文) | `mcp_request_log`への全7 INSERT箇所の文脈、`/ingest`の拒否系統無記録、GitHub Webhook全体の無記録を確認 |
| `src/mcp/http-transport.ts` | 冒頭コメント読了。レガシー`gbrain serve --http`用の別実装であることを確認 |
| `src/commands/serve.ts`(60-100行) | `--http`フラグが`http-transport.ts`ではなく`serve-http.ts`へ排他的にディスパッチすることを確認(前者はdead code) |
| `src/core/minions/queue.ts`(190-335行、`add()`全文) | `parent_job_id`の深さ制限(`maxSpawnDepth`)・`max_children`制約の実装確認 |
| `src/core/operations.ts`(`submit_agent`全文、3038-3192行) | `parent_job_id`を一切使用しないことの確認 |
| `src/core/minions/handlers/subagent.ts`(240-300行付近) | ツールレジストリ構築(`buildBrainTools`/`filterAllowedTools`)の確認 |
| `src/core/minions/tools/brain-allowlist.ts` | grep。`submit_agent`という文字列が0件であることの確認 |
| `src/core/minions/self-fix.ts`, `src/commands/agent.ts` | `parent_job_id`の実際の利用箇所(内部メンテナンス機構・ローカルCLI aggregatorパターン)の確認 |
| `src/core/operations.ts`(`ctx.remote`全80件以上) | ローカル信頼境界が広範な認可分岐に関与することの確認、「the trust boundary is the OS」という一次コメント(2491行) |
| `src/commands/*.ts`(`remote: false`設定箇所30件以上) | ハードコードされたリテラル値であり、OSレベルの識別子と無関係であることの確認 |

## 2. 実行した検索コマンド(代表例)

```
grep -n "'/mcp'\|\"/mcp\"\|'/mcp-v2'\|bearerAuth\|requireBearerAuth\|verifyAccessToken" src/commands/serve-http.ts
grep -rn "claude\|chatgpt\|gemini\|anthropic\|openai\|grok\|hermes" src/ --include=*.ts -l
grep -rn "tenant\|organization\|org_id\|multi-tenant" src/core/*.ts
grep -n "CREATE TABLE" src/schema.sql
grep -n "AgentId\|AGENT_SPECS" src/commands/connect.ts
grep -n "INSERT INTO mcp_request_log" src/ -r
grep -n "app\.\(get\|post\|put\|delete\)(\s*['\"]\/admin" src/commands/serve-http.ts
grep -rn "parent_job_id" src/
grep -n "submit_agent" src/core/minions/tools/brain-allowlist.ts
grep -n "AgentJobData" src/ -r
grep -n "ctx\.remote" src/core/operations.ts
grep -rn "remote: false\|remote: true" src/commands/*.ts src/core/operations.ts
```

## 3. 実行したテスト

**なし。** Phase 9A・補完監査ともに調査・文書作成のみが許可範囲であり、変更禁止対象(本番ソースコード、DBスキーマ、認証・認可処理等)に対する挙動確認テストは実施していない。Phase 8で実施済みの実機テスト結果は既存の記録として引用したのみ。

## 4. 現在も未確認の事項(確認済みになった項目は本セクションから除外済み)

以下は依然として未確認であり、`PHASE9A-CURRENT-STATE-AUDIT.md`・`PHASE9A-SUPPLEMENTAL-AUDIT.md`中でも「未確認」と明記されている。

1. **`admin/src/pages/Agents.tsx`・`Dashboard.tsx`・`Calibration.tsx`・`JobsWatch.tsx`の詳細実装** — 一覧上の存在確認のみ、内容未読了。
2. **`adminSessions`の実データ構造(Map値の型)** — ルート登録は確認したが、ハンドラ本体・データ構造は未読了。「sign-out-everywhere」が実際に全セッションを一括失効させる実装かは未確認。
3. **`mcp_request_log`への書き込みタイミングの網羅性** — `/mcp`・`/mcp-v2`・`/ingest`の主要経路は確認したが、他に存在しうる小規模なエントリポイントを全て洗い出せているかの完全性は保証しない。
4. **トークンのキャッシュ・コネクションプーリングレベルでの権限反映タイミング** — `AuthInfo`がリクエストごとにDBから解決される旨のコメントは確認したが、接続プーリング層(PGLite/Postgres双方)でのキャッシュ挙動の詳細は未検証。
5. **`@modelcontextprotocol/sdk`側の`OAuthServerProvider`インターフェース契約の詳細** — gbrainがどう実装しているかは確認したが、SDK自体のソースは範囲外(gbrainリポジトリ内のみ調査)。
6. **`evals/`, `examples/`ディレクトリ** — 存在確認のみ、内容未調査。
7. **分散/共有ホスト・コンテナ・CI/CD環境での実運用検証** — `ctx.remote`の信頼境界に関する記述は静的コード解析のみに基づき、実環境での動作検証は行っていない。
8. **委任の有効期限と元Credentialの有効期限の突き合わせ実装有無**(`AUTHZ-INV-007`関連) — `submit_agent`の`timeout_ms`がトークンTTLと比較されているかどうかは未確認。

### 確認済みになった項目(参考: 旧「未確認」からの移行)

- ~~管理画面の認証・認可・監査経路~~ → 確認済み(`PHASE9A-SUPPLEMENTAL-AUDIT.md`§2)
- ~~CLIローカル実行が`mcp_request_log`を経由するかどうか~~ → 確認済み、経由しない(同§5-6)
- ~~孫委任の権限継承ロジック~~ → 確認済み、現状不可能(同§4)
- ~~`mcp_request_log`書き込み経路の網羅~~ → 主要7サイトについて確認済み(同§3、ただし上記§4-3参照)
- ~~GitHub Webhook HMACの分類~~ → 確認済み、メッセージ真正性検証として分類確定(`PHASE9A-CURRENT-STATE-AUDIT.md`§2)
- ~~既存設計文書との矛盾有無~~ → 確認済み、矛盾なし(同§1補完監査)

## 5. 事実と推測の分離(最終状態)

| 記述 | 分類 | 根拠 |
|---|---|---|
| 認証・認可コアに製品名分岐がない | **事実** | `oauth-provider.ts`/`scope.ts`/`operations.ts`の全文またはgrep結果に基づく直接確認 |
| `connect.ts`のみが唯一の製品名分岐箇所である | **事実(調査範囲内)** | grep全件ヒットを個別に分類。`admin/`配下は§4-1の理由により完全網羅ではない |
| PGLiteがsingle-tenant by designである | **事実** | `migrate.ts`等のコメントに複数箇所で明記 |
| CLIローカル実行が監査ログを経由しない | **事実(確認済み)** | `src/commands/*.ts`の`INSERT INTO mcp_request_log`呼び出し0件 |
| 孫委任が現状不可能である | **事実(確認済み)** | `submit_agent`の`parent_job_id`不使用、subagentツールレジストリに`submit_agent`不在 |
| 管理画面操作が一切監査記録されない | **事実(確認済み)** | 全19`/admin/api/*`ルートの周辺に`INSERT INTO mcp_request_log`が0件 |
| GitHub Webhook HMACは主体認証ではなくメッセージ真正性検証である | **判断(根拠付き)** | AuthInfo非生成・hasScope非到達・Session不成立・Source識別という4点の構造的差異に基づく分類判断 |
| ローカル実行の信頼境界がOSに委譲されている | **事実** | `operations.ts:2491`の一次コメント「the trust boundary is the OS」を直接引用 |
| Phase 9B以降の分割・依存順序案 | **提案(事実ではない)** | `PHASE9A-GAP-AND-ROADMAP.md`・`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`は現状分析に基づく推奨案であり、確定した実装計画ではない |
| Principal種別を`principal_kinds`登録テーブルで保存する | **決定(実装前の設計判断)** | A/B/C/D比較の結果としての選択であり、既存コードの事実ではない |
| Universal化10項目判定の各PASS/PARTIAL/FAIL | **判断(根拠付き)** | 各判定に具体的なファイル名・行番号・型名・テーブル名を根拠として明記 |

## 6. 8文書間の優先順位

Phase 9Aの成果物は最終的に8文書になった。文書間で記述が食い違った場合にどれを正本とするかを、以下の優先順位で明記する。

1. **`PHASE9A-IDENTITY-MODEL-DECISION.md`** — 最優先。概念定義そのものの確定であり、他の全文書の語彙・構造がこれに従う。
2. **`PHASE9A-AUTHORIZATION-INVARIANTS.md`** — 次点。概念の上に成り立つ「守るべき規則」であり、1の語彙を前提に定義される。
3. **`PHASE9A-SUPPLEMENTAL-AUDIT.md`** — 3番目。1・2の判断の根拠となった実コードの証跡そのものであり、事実確認の一次資料として扱う。
4. **修正後の既存Phase 9A文書**(`PHASE9A-CURRENT-STATE-AUDIT.md`・`PHASE9A-TARGET-DOMAIN-MODEL.md`・`PHASE9A-GAP-AND-ROADMAP.md`・本マニフェスト) — 4番目。1〜3と整合するよう修正済みだが、初版起源のより広い調査範囲を扱うため、詳細な設計判断そのものについては1〜3を正本とする。
5. **`PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`** — 最後。最も実装に近い提案であり、1〜4から導かれる派生的な結論。今後の議論で最も更新頻度が高くなると想定される文書のため、他の4層より下位に置く。

**根拠**: 概念定義(1)→規則(2)→証跡(3)→現状分析(4)→実装提案(5)という順序は、上位の文書ほど変更頻度が低く安定していること、下位の文書ほど上位の内容から論理的に導出される派生物であることに基づく。矛盾が生じた場合は、常に上位文書の記述を正としてください。

## 7. 変更を行わなかったことの確認

- 現状監査・補完監査ともに、`/Users/lab/AI_Workspace/gbrain/`配下の既存ファイルへの書き込み・編集は一切実施していない(全てRead/Bashのgrepのみ)。
- 認証・認可処理、MCP/HTTP/CLI/管理画面の動作、DBスキーマ、マイグレーションへの変更は一切行っていない。
- `.claude/settings.json`・`.claude/settings.local.json`への変更は行っていない。
- 作成・更新したファイルは、本マニフェストを含む以下8件のみである:
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-CURRENT-STATE-AUDIT.md`(2026-07-31作成、2026-08-01更新)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-TARGET-DOMAIN-MODEL.md`(2026-07-31作成、2026-08-01更新)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-GAP-AND-ROADMAP.md`(2026-07-31作成、2026-08-01更新)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-EVIDENCE-MANIFEST.md`(本ファイル、2026-07-31作成、2026-08-01更新)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-SUPPLEMENTAL-AUDIT.md`(2026-08-01新規作成)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-IDENTITY-MODEL-DECISION.md`(2026-08-01新規作成)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9A-AUTHORIZATION-INVARIANTS.md`(2026-08-01新規作成)
  - `/Users/lab/AI_Workspace/gbrain/PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md`(2026-08-01新規作成)
- 上記8件はいずれもgit上**未追跡(`??`)のファイル**である(2026-07-31時点で一度もコミットされていないため)。したがって「追跡済み本番ファイルへの変更」は今回のいずれの作業でも発生していない。「変更」という語は、未追跡ファイルの内容を編集した(Edit)ことを指し、gitで追跡されたバージョン管理対象への変更ではないことに注意する。

## 8. モデル・エージェント使用の記録

- 本Phase・補完監査ともにSonnet(本セッション)が直接実行した。
- サブエージェントは一切使用していない(ユーザーの明示指示「使用モデルはSonnetとし、サブエージェントは原則使用しない」に従った)。
