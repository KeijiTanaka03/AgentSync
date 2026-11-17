# AgentSync

Claude と GPT が同居する、LINE 風のグループチャットです。Mac のデスクトップアプリとして、個人で使うために作っています。

- Claude と GPT に、個別に話しかけることも、両方へ同時に送ることもできます
- 「対話モード」ボタンを押すと、その時点の会話の続きから Claude と GPT が交互に話し続けます。もう一度押すと止まります
- コーディングモードでは、プロジェクトのフォルダを指定すると、普段の Claude Code / Codex と同じように作業できます。片方が実装し、もう片方がレビューするループも回せます

## 状態

開発中です。今は、個別送信・同時送信・会話の保存と一覧まで使えます。対話モードとコーディングモードはこれからです。構想は [PLAN/PLAN.md](PLAN/PLAN.md)、画面案は [PLAN/screens/](PLAN/screens/index.html) にあります。

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

## アプリとして使う

```sh
npm install
npm run install:app   # AgentSync.app を作り、アプリケーションフォルダに入れる
```

- 自分の Mac でビルドしたアプリなので、そのまま起動できます（Apple の公証は受けていません）
- 会話は `~/Library/Application Support/AgentSync/conversations/` に、会話ごとの小さな JSON ファイルとして保存されます。ファイルは自分だけが読める権限で作ります
- 返事を待つあいだ、吹き出しに各 AI がいま何をしているか（考え中・ウェブを検索中・入力中）と、経過した秒数が出ます。「全員」に送ると、2 人は同時に考え、同時に答えます
- ヘッダーの「Claude」「GPT」を押すと、それぞれの考える深さ（effort）を選べます。浅くするほど速く答えます。「自動」は各 CLI の設定のままです。選んだものは次の返事から使われ、新しい会話にも引き継がれます（`settings.json` に保存）
- 会話の名前は、最初のメッセージから自動で付きます。変えるには、サイドバーの会話の「…」メニュー（右クリックでも開きます）の「名前を変更」を選ぶか、会話をダブルクリックするか、ヘッダーの名前をクリックします。Enter で決定、Escape で取り消しです
- 同じメニューの「削除…」で会話を削除すると、このファイルが消えます。Claude Code と Codex 側の履歴は残ります

## 開発

```sh
npm install
npm run dev        # 開発モードで起動（初回は Electron 本体をダウンロードします）
npm test           # 単体テスト
npm run typecheck  # 型チェック
npm run build      # 本番用にビルド（out/ に出力）
npm run dist       # AgentSync.app を作る（release/ に出力）
npm run icon       # build/icon.svg からアプリのアイコン（build/icon.png）を作り直す（案は PLAN/icon/ にあります）
```

- Node.js は 22.12 以降が対象です（推奨は 24 LTS）
- npm 10.9 系では、新しいパッケージを追加するときに依存解決のエラーが出ることがあります。その場合は npm 11 以降を使ってください（`package-lock.json` からのインストールは問題ありません）
- 開発中（`npm run dev`）の会話は、アプリとは別の `~/Library/Application Support/AgentSync-dev/` に保存されます

### 実際の CLI を使った確認

```sh
npm run test:e2e
```

Claude Code CLI と Codex CLI を実際に呼び出して、同時送信と、相手の発言が文脈として届くこと、アプリを起動し直しても各 AI が会話の続きを覚えていることを確かめます。少しだけ使用枠を消費します（既定では小さいモデルを使います。`AGENTSYNC_CLAUDE_MODEL` と `AGENTSYNC_GPT_MODEL` で変えられます）。

### 開発用の環境変数

| 変数 | 内容 |
|---|---|
| `AGENTSYNC_CLAUDE_MODEL` / `AGENTSYNC_GPT_MODEL` | 使うモデル（例: `haiku`、`gpt-6-luna`）。未指定なら各 CLI の既定 |
| `AGENTSYNC_CLAUDE_PATH` / `AGENTSYNC_CODEX_PATH` | CLI の場所を直接指定する |
| `AGENTSYNC_SELFTEST=<出力先.png>` | 画面からメッセージを 1 回送り、ウィンドウの画像を保存して終了する（パッケージ化したアプリでは無効）。データは使い捨てのフォルダに置く |
| `AGENTSYNC_SELFTEST_DATA=<フォルダ>` | セルフテストのデータを置くフォルダ。同じフォルダでもう一度動かすと、保存した会話の続きから試せる |

## 注意

- 各 CLI の認証情報を、アプリから外に送ることはありません。アプリはネットワークのポートも開けません
- 各サービスの利用規約の範囲で、自分のマシンで自分のアカウントを使ってください
- このプロジェクトは個人のものです。Anthropic や OpenAI とは関係ありません
