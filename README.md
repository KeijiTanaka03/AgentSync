# AgentSync

Claude と GPT が同居する、LINE 風のグループチャットです。Mac のデスクトップアプリとして、個人で使うために作っています。

- Claude と GPT に、個別に話しかけることも、両方へ同時に送ることもできます
- 「対話モード」ボタンを押すと、その時点の会話の続きから Claude と GPT が交互に話し続けます。もう一度押すと止まります
- コーディングモードでは、プロジェクトのフォルダを指定すると、普段の Claude Code / Codex と同じように作業できます。片方が実装し、もう片方がレビューするループも回せます

## 状態

開発中です。構想は [PLAN/PLAN.md](PLAN/PLAN.md)、画面案は [PLAN/screens/](PLAN/screens/index.html) にあります。

## 仕組み

API キーは使いません。手元に入れた **Claude Code CLI** と **Codex CLI** を、アプリが裏で呼び出します。

- 各 CLI には、自分のアカウントでログインしておく必要があります
- 使用量は、それぞれのプランの使用枠から消費されます
- 会話は、各 CLI とこのアプリの手元のファイルにだけ保存されます

## 必要なもの

- macOS
- Node.js
- Claude Code の CLI（`claude`）。Claude のプランでログイン済みであること
- [Codex CLI](https://github.com/openai/codex)（`codex`）。ChatGPT のプランでログイン済みであること

## 開発

```sh
npm install
npm run dev        # 開発モードで起動（初回は Electron 本体をダウンロードします）
npm test           # 単体テスト
npm run typecheck  # 型チェック
npm run build      # 本番用にビルド（out/ に出力）
```

- Node.js は 22.12 以降が対象です（推奨は 24 LTS）
- npm 10.9 系では、新しいパッケージを追加するときに依存解決のエラーが出ることがあります。その場合は npm 11 以降を使ってください（`package-lock.json` からのインストールは問題ありません）

### 実際の CLI を使った確認

```sh
npm run test:e2e
```

Claude Code CLI と Codex CLI を実際に呼び出して、同時送信と、相手の発言が文脈として届くことを確かめます。少しだけ使用枠を消費します（既定では小さいモデルを使います。`AGENTSYNC_CLAUDE_MODEL` と `AGENTSYNC_GPT_MODEL` で変えられます）。

### 開発用の環境変数

| 変数 | 内容 |
|---|---|
| `AGENTSYNC_CLAUDE_MODEL` / `AGENTSYNC_GPT_MODEL` | 使うモデル（例: `haiku`、`gpt-6-luna`）。未指定なら各 CLI の既定 |
| `AGENTSYNC_CLAUDE_PATH` / `AGENTSYNC_CODEX_PATH` | CLI の場所を直接指定する |
| `AGENTSYNC_SELFTEST=<出力先.png>` | 画面からメッセージを 1 回送り、ウィンドウの画像を保存して終了する（パッケージ化したアプリでは無効） |

## 注意

- 各 CLI の認証情報を、アプリから外に送ることはありません。アプリはネットワークのポートも開けません
- 各サービスの利用規約の範囲で、自分のマシンで自分のアカウントを使ってください
- このプロジェクトは個人のものです。Anthropic や OpenAI とは関係ありません
