# Phase 9C〜9E-1 — 本番反映手順・観察開始条件(計画のみ・未実行)

**日付**: 2026-08-03
**位置づけ**: `PHASE9E1-RELEASE-READINESS.md`のコミット分割案が適用され、`build-release.sh`でリリースが作成された後に実施する本番反映手順の計画。**本書に記載のコマンドは今回一切実行していない。**
**正本**: 本書は`docs/PRODUCTION-DEPLOYMENT.md`の一般手順を前提とし重複させない。既存スクリプト(`scripts/release/{build-release,deploy,rollback,status,cleanup,smoke-test}.sh`)をそのまま使う箇所は参照のみに留め、Phase 9C〜9E-1固有の追加検証のみをここに明記する。

---

## 0. 現状確認済み事実(実行前提)

- 本番: `com.user.gbrain`(launchd、PID稼働中)、`/Users/lab/AI_Production/gbrain/current` → commit `d2c9ae8d`(migration v124)、DBは`~/.gbrain/brain.pglite`(PGLite)
- **重要な既知制約(`docs/PRODUCTION-DEPLOYMENT.md`「PGLite exclusivity」節、確認済み)**: サービス稼働中に別プロセスから`~/.gbrain`を直接開こうとすると`Timed out waiting for PGLite lock`で安全にハングするのみで進行しない(破損はしない)。**サービス停止なしに本番PGLiteへ直接アクセスする手段は存在しない**——これが手順3〜4・観察開始条件の設計の前提。
- **重要な既知の欠落**: `scripts/release/deploy.sh`はマイグレーションを自動実行しない(`build-release.sh`が`postinstall`の`apply-migrations`呼出しを意図的に`--ignore-scripts`で無効化している——本番への誤マイグレーション事故を防ぐ設計)。**今回のリリースはmigration v125-128を含むため、手順6で明示的な手動マイグレーションステップが必須**(既存パイプラインのデフォルト動作だけでは不十分)。

---

## 1. 事前バックアップ

`scripts/release/deploy.sh`は内部でデータバックアップを取得する(`docs/PRODUCTION-DEPLOYMENT.md`「Deploy」節)。追加で、migrationを伴う今回のリリースでは**deploy.sh呼び出し前に独立した手動バックアップ**も取得することを推奨する(4件の新規migrationが関わるため、deploy.sh標準バックアップに加えた二重の安全網):

```
cp -a /Users/lab/.gbrain /Users/lab/AI_Production/gbrain-manual-backups/$(date +%Y%m%d)-pre-phase9c-9e1-cutover
```

## 2. バックアップ整合性確認

コピー後、バックアップ先の`brain.pglite/`ディレクトリサイズが元と一致することを確認し、バックアップ先で`gbrain doctor`(GBRAIN_HOMEをバックアップ先の親ディレクトリに向けて)を実行し、`connection`チェックが`ok`になることを確認する(実データが読めることの検証)。

## 3. サービス停止

```
launchctl bootout gui/$(id -u)/com.user.gbrain
```

## 4. PGLiteロック解放確認

停止直後、`~/.gbrain/.locks/`配下のロックファイルが解放されていることを確認してからでないと次の手順(migration適用)がハングする。`docs/PRODUCTION-DEPLOYMENT.md`が言及する`Timed out waiting for PGLite lock`が出る場合は、プロセスが完全に終了していない(`ps aux | grep gbrain`で残存プロセスがないか確認)。

## 5. リリース配置

```
scripts/release/build-release.sh   # コミット後のクリーンなツリーから実行(--allow-dirty不使用)
scripts/release/deploy.sh <新リリース名>
```

`deploy.sh`はpreflight→停止→バックアップ→`current`/`previous`アトミックスワップ→起動→smoke-testを自動実行する。**ただしmigrationは実行しない**(下記手順6)。`deploy.sh`が内部でサービスを起動してしまう前提のため、実際の運用では手順6(migration)を`deploy.sh`の起動ステップの直前・直後どちらに挟むか、`scripts/release/lib.sh`のフック機構を事前に確認してから決定する必要がある(本書では確認していない——実行時の追加調査事項として明記)。

## 6. 必要なmigrationの適用(今回のリリース固有・手動)

```
GBRAIN_HOME=<production home親ディレクトリ> gbrain apply-migrations --yes --non-interactive
```

適用後、`gbrain doctor`または`gbrain migrate --status`相当のコマンドで`schema_version`がv128になっていることを確認する。**v125(Phase 9B principal_kinds/principals)からv128(Phase 9C audit_events統合)までの4件が一括適用される — 個別に分割適用する手段は現状のmigrateフレームワークにはない(逐次適用ではあるが実行は一括コマンド)。**

## 7. サービス起動

`deploy.sh`が自動実行(手順5に包含)。手動の場合:
```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.gbrain.plist
```

## 8. health確認

```
scripts/release/status.sh   # 読み取り専用、current/previous・live /health ping
```
`smoke-test.sh`が`deploy.sh`内で自動実行済み(`/health`・`/mcp`・`/mcp-v2`到達性)。

## 9. OAuth/MCPスモーク

`smoke-test.sh`でカバーされない追加確認(今回のリリース固有):
- 既存の登録済みOAuthクライアントでトークン発行(`POST /token`)が引き続き成功することを1件確認(既存クライアントへの影響ゼロという設計目標の実地検証)
- `gbrain auth register-client`で新規テストクライアントを一時登録し、正常に動作すること・登録後に`gbrain auth revoke-client`で確実に削除できることを確認(本番データに残さない)

## 10. Audit Event確認

```
GBRAIN_HOME=<production home親> gbrain audit status
```
`audit_spill_pending`・corrupt/critical-failuresがいずれも健全(0/false)であることを確認。**このコマンド自体もPGLite直接アクセスのためサービス稼働中は実行できない**——手順4と同じ制約。稼働中に確認したい場合は、11.のdoctor実行と合わせてサービス起動直後の短い確認ウィンドウ、または後述§観察開始条件のAPI経由方式を使う。

## 11. doctor実行

```
GBRAIN_HOME=<production home親> gbrain doctor
```
特に`delegation_capability_health`(新規)と`oauth_confidential_client_health`が`ok`または想定通りの`warn`であることを確認する。

## 12. ログ確認

`shared/logs/`配下の起動直後のログに、audit書込み失敗(`audit_write_failures_total`相当のエラーログ)がないことを確認する。

## 13. ロールバック判定条件

以下のいずれかに該当したら即座にロールバック(手順14)を判断する:
- `smoke-test.sh`が非ゼロ終了(`deploy.sh`が自動でロールバック試行するが、exit code 3の場合は自動ロールバックも失敗しているため手動介入が必要)
- 手順6のmigration適用がエラーで終了(部分適用の可能性 — 個々のmigrationはトランザクション内で実行される設計だが、複数migration一括適用の途中失敗時の状態は事前に要確認)
- 手順9のOAuthスモークで既存クライアントのトークン発行が失敗
- 手順10-11でaudit write failureまたはdoctorのfail(warnではなくfail)が検出される

## 14. 旧リリースへの切戻し

```
scripts/release/rollback.sh
```
`current`/`previous`をスワップし再起動・smoke-test。**ただしmigrationは切り戻さない**(v128のスキーマのまま旧コード`d2c9ae8d`を動かすことになる — 旧コードはv128の新規テーブル・列を単に無視するだけで動作するはずだが、これは本書では未検証。実行前に旧コードがv128スキーマに対して安全に動作するかの確認を追加タスクとして推奨する)。

## 15. DBバックアップからの復元条件

手順14のコードロールバックだけでは不十分な場合(migration適用が原因でデータ不整合が疑われる場合)のみ、手順1のバックアップから`~/.gbrain`を復元する。これは`docs/PRODUCTION-DEPLOYMENT.md`「Emergency recovery」節の手順に従う(本書では複製しない)。

---

## AUTHZ-INV-017観察開始条件

### 核心的な制約: 集計CLIは稼働中の本番へ直接実行できない

`gbrain audit delegation-scope-shortfalls`は独立プロセスとしてDB接続を開くため、上記「PGLite排他ロック」制約により**サービス稼働中は実行できない**(実行するとハングする)。したがって「30日待って集計CLIを叩く」という単純な運用は成立しない。

### 推奨する仕組み(未実装・要別途実装承認)

`queryDelegationScopeShortfalls(engine, opts)`は既にengine注入可能な純粋関数として実装済みであるため、**稼働中のサーバー自身が保持する既存のengineハンドルを再利用する読み取り専用管理APIエンドポイント**(例: `GET /admin/api/delegation-scope-shortfalls`)を追加することで、新規PGLite接続を一切開かずに安全に実行できる。これは小さく境界の明確な追加(既にテスト済みのロジックを薄いルートハンドラで包むだけ)だが、**今回は実装していない**(コード変更禁止のため)。この追加を9E-2準備の次タスクとして提案する。

代替案(APIを追加しない場合): メンテナンス停止中の直接実行のみが手段となる。これは日次〜週次の定期観察には非現実的(毎回サービス停止が必要)なため、**継続的な観察が目的なら管理API方式を強く推奨する**。

### 各質問への回答

| 質問 | 回答 |
|---|---|
| `delegation_scope_shortfall`が実際に記録される確認方法 | デプロイ後、手順9のOAuthスモークで意図的にscope不足の委任を1回発生させ(またはagent scopeのみのテストクライアントで委任を試み)、`gbrain audit status`または(サービス停止時)直接`audit_events`を確認する |
| 集計CLIの本番での安全な実行方法 | 上記「推奨する仕組み」の管理API経由(未実装)。それまでは停止時のみ |
| PGLiteロックを避ける方法 | 稼働中のプロセス自身のengineを再利用する(=別プロセスを起動しない)以外に方法はない |
| 同一プロセス内CLI/APIとして実行可能か | **可能**(上記の管理API方式で実現できる。既存の`queryDelegationScopeShortfalls`がそのまま再利用可能) |
| 読み取り専用管理API追加が必要か | **必要**(継続観察を現実的にする唯一の方法) |
| メンテナンス停止中の直接実行しか方法がないか | 管理APIを追加しない場合はその通り。追加すれば不要になる |
| 観察期間の起算条件 | 本番へのPhase 9E-1(delegation_scope_shortfall書込みパス)デプロイ完了・手順9スモーク確認完了の時刻から起算。今日の日付や計画時点を起算日にしない |
| 最低観察期間 | 30日を初期推奨値とする(集計CLI自体の`--since-days`デフォルトと一致させ運用の一貫性を保つ)。ただし件数が極端に少ない場合(下記)は延長する |
| enforce判断に必要な件数・条件 | (a) 少なくとも1回の定常的な委任利用サイクル(定期実行されるsubagentジョブが一通り動いている)が観測されていること (b) `would_be_denied`のクライアントが残っていないか、残っている場合は個別の是正計画が確定していること (c) `truncated: true`が一度も出ていないこと(全体像を捉えられている確信) |
| 0件の場合の扱い | **「0件=安全」と即断しない**。まず`delegation.grant`/`delegation.deny`イベント全体の件数を確認し、委任機能自体がそもそも使われているかを確認する。委任利用自体が0件なら「未検証」であり「合格」ではない |
| `truncated: true`の場合の扱い | 完全な集計とみなさない。`--limit`を安全な範囲で引き上げるか`--client-id`で分割して再確認してから判断する(CLI自身がこの案内を出力する設計) |

---

## 参照元

- `docs/PRODUCTION-DEPLOYMENT.md`
- `PHASE9E1-RELEASE-READINESS.md`
- `PHASE9E-DELEGATION-DOMAIN-MODEL.md`§5(AUTHZ-INV-017段階移行表)
- Beads: `dashboard-qj0ir`・`dashboard-fqotx`
