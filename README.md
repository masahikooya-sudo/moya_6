# Local Gemma Chat

[Ollama](https://ollama.com) 上で動く Gemma モデルとチャットできる、シンプルなローカル LLM Web アプリです。

- バックエンド: Node.js + Express（Ollama の `/api/chat` をストリーミングでプロキシ）
- フロントエンド: 素の HTML/CSS/JS のチャット UI
- 会話履歴の保存(ブラウザの localStorage、複数チャットを切り替え可能)
- 複数モデルの切り替え UI(Ollama にダウンロード済みのモデル一覧から選択)
- 個人情報チェック機能(`.xlsx` / `.pdf` をアップロードし、マスキング漏れがないか
  正規表現とAI(Gemma)の両方でチェック)

## 必要なもの（Docker）

- Docker / Docker Compose

## セットアップ（Docker、推奨）

`docker-compose.yml` は Ollama コンテナとアプリコンテナをまとめて起動します。
Ollama を別途インストールする必要はありません。

1. コンテナをビルド・起動する。

   ```bash
   docker compose up -d --build
   ```

2. Gemma モデルを Ollama コンテナに取得する（初回のみ）。

   ```bash
   docker compose exec ollama ollama pull gemma4
   ```

   > **注記:** Gemma 4 は `e2b` / `e4b` / `12b` / `26b`(MoE) / `31b` の5サイズが
   > `gemma4` ライブラリで公開されています。タグを省略した `gemma4`(=`gemma4:latest`)は
   > オンデバイス向けの `e4b`(約9.6GB)を取得します。マシンのスペックに応じて
   > `docker compose exec ollama ollama pull gemma4:12b` のように明示的にサイズを
   > 指定することもできます。利用可能なタグ一覧は
   > https://ollama.com/library/gemma4 で確認できます。

3. ブラウザで http://localhost:3000 を開いてチャットする。

使用するモデル(サイズ)を変えたい場合は、`.env` に `MODEL_NAME=gemma4:12b` のように設定してから
`docker compose up -d --build` を実行してください（`.env.example` 参照）。
NVIDIA GPU を使いたい場合は `docker-compose.yml` 内の `deploy.resources` のコメントを
外し、[nvidia-container-toolkit](https://github.com/NVIDIA/nvidia-container-toolkit) を
ホストにインストールしてください。

停止する場合:

```bash
docker compose down
```

モデルデータは `ollama_data` という Docker ボリュームに保存されるため、
`docker compose down` しても再取得は不要です（`docker compose down -v` で削除されます）。

## Dockerを使わない場合（Node.jsを直接実行）

- Node.js 18 以上
- [Ollama](https://ollama.com/download) をローカルにインストール・起動しておく

1. Gemma モデルを取得する。

   ```bash
   ollama pull gemma4
   ```

2. 依存パッケージをインストールする。

   ```bash
   npm install
   ```

3. 環境変数を設定する（任意）。`.env.example` を参考に `.env` を作成するか、
   起動時に環境変数として指定してください。

   | 変数名        | デフォルト値                 | 説明                          |
   | ------------- | ---------------------------- | ----------------------------- |
   | `PORT`        | `3000`                       | Web アプリの待受ポート        |
   | `OLLAMA_HOST` | `http://127.0.0.1:11434`     | Ollama サーバーのアドレス     |
   | `MODEL_NAME`  | `gemma4`                     | 使用する Ollama モデル名/タグ |

4. アプリを起動する。

   ```bash
   MODEL_NAME=gemma4 npm start
   ```

5. ブラウザで http://localhost:3000 を開いてチャットする。

## 個人情報チェック機能

ヘッダーの「個人情報チェック」タブから、マスキング済みのはずの `.xlsx` / `.pdf` ファイルを
アップロードすると、以下の14種類の個人情報がまだ残っていないかを確認できます。

人物名 / 住所・地名 / 企業名・組織名 / 日付 / 時刻 / 金額 / 数量 / 電話番号 /
メールアドレス / マイナンバー / 郵便番号 / クレジットカード番号 / 銀行口座番号 /
パスポート番号

チェックは2つの方法を組み合わせて行います。

1. **正規表現によるパターンマッチング**(メールアドレス、電話番号、郵便番号、
   マイナンバー、クレジットカード番号(Luhnアルゴリズムで検証)、銀行口座番号、
   パスポート番号、日付・時刻・金額・数量の代表的な表記など)。
2. **AI(Gemma)による確認**(ファイルからテキストを抽出し、Ollama経由でGemmaに
   人物名・住所・企業名なども含めた14種類すべての確認を依頼)。

検出結果は種類・検出内容・検出方法(パターン検出/AI検出)・場所(xlsxはシート名と
セル番地、pdfはページ番号)を一覧表示します。Ollamaが起動していない場合は正規表現による
結果のみを表示し、その旨を警告として表示します。

> **注意:** このチェックは補助的なものであり、検出漏れ(偽陰性)が発生する可能性が
> あります。特に人物名・住所・企業名などはAIの判断精度に依存するため、チェック結果に
> かかわらず、必ず目視でも内容を確認してください。アップロードできるファイルは
> `.xlsx` と `.pdf` のみで、ファイルサイズの上限は50MBです。

## 仕組み

- ブラウザはこれまでの会話履歴（`{role, content}` の配列）とモデル名を `/api/chat` に POST する。
- サーバーはそれを Ollama の `POST /api/chat`（`stream: true`）に転送する。
- Ollama から返る NDJSON ストリームをサーバーで逐次パースし、生成テキストのみを
  チャンクとしてブラウザへ流し、画面にリアルタイム表示する。
- サーバーは `GET /api/models` で Ollama の `GET /api/tags` を呼び出し、ダウンロード済み
  モデルの一覧をヘッダーのセレクトボックスに表示する。会話ごとに使用するモデルを
  切り替えて記憶できる。
- 会話履歴(複数チャット分)はブラウザの `localStorage` に保存される。サイドバーから
  過去のチャットを選択・削除・新規作成できる。ブラウザのデータを消去すると履歴も
  消えるので注意(サーバー側やファイルには保存されない)。
- 個人情報チェックは `POST /api/pii-check`(multipart/form-data、`file` と `model`)で
  受け付ける。サーバーは `.xlsx` は [exceljs](https://github.com/exceljs/exceljs)、
  `.pdf` は [pdf-parse](https://github.com/mehmet-kozan/pdf-parse) でテキストを抽出し、
  `lib/pii.js` の正規表現でパターン検出、抽出テキストをチャンク分割してOllamaの
  `POST /api/chat`(`format: "json"`)に渡してAI検出を行い、結果をマージして返す。
  アップロードしたファイルの内容や検出結果はサーバー・ディスクに保存されない。

## トラブルシューティング

- 「Ollamaに接続できませんでした」と表示される場合は、`ollama serve`（または
  `docker compose ps` で `ollama` コンテナ）が起動しているか、`OLLAMA_HOST` の値が
  正しいかを確認してください。
- モデルが見つからないエラーが出る場合は `ollama list`(Docker の場合
  `docker compose exec ollama ollama list`)で取得済みモデル名を確認し、
  `MODEL_NAME` を一致させてください。
- 個人情報チェックで「ファイルの解析に失敗しました」と表示される場合、パスワード保護
  されたファイルや破損したファイルの可能性があります。パスワードを解除してから
  再度アップロードしてください。
- 個人情報チェックがOllama未接続の警告とともに正規表現の結果のみを返す場合は、
  Ollamaが起動しているか確認してください(AIによる人物名・住所などのチェックには
  Ollamaへの接続が必要です)。
