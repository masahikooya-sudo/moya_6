# Local Gemma Chat

[Ollama](https://ollama.com) 上で動く Gemma モデルとチャットできる、シンプルなローカル LLM Web アプリです。

- バックエンド: Node.js + Express（Ollama の `/api/chat` をストリーミングでプロキシ）
- フロントエンド: 素の HTML/CSS/JS のチャット UI
- 会話履歴の保存（ブラウザの localStorage、複数チャットを切り替え可能）
- 複数モデルの切り替え UI（Ollama にダウンロード済みのモデル一覧から選択）

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

   > **注記:** 2026年9月時点で Ollama のライブラリに `gemma4` タグが存在しない場合は、
   > 代わりに `gemma3`（例: `docker compose exec ollama ollama pull gemma3`）などの
   > 利用可能な Gemma のタグを取得し、`MODEL_NAME` をそれに合わせて設定してください。
   > 利用可能なモデル一覧は https://ollama.com/library で確認できます。

3. ブラウザで http://localhost:3000 を開いてチャットする。

使用するモデルを変えたい場合は、`.env` に `MODEL_NAME=gemma3` のように設定してから
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

## 仕組み

- ブラウザはこれまでの会話履歴（`{role, content}` の配列）とモデル名を `/api/chat` に POST する。
- サーバーはそれを Ollama の `POST /api/chat`（`stream: true`）に転送する。
- Ollama から返る NDJSON ストリームをサーバーで逐次パースし、生成テキストのみを
  チャンクとしてブラウザへ流し、画面にリアルタイム表示する。
- サーバーは `GET /api/models` で Ollama の `GET /api/tags` を呼び出し、ダウンロード済み
  モデルの一覧をヘッダーのセレクトボックスに表示する。会話ごとに使用するモデルを
  切り替えて記憶できる。
- 会話履歴（複数チャット分）はブラウザの `localStorage` に保存される。サイドバーから
  過去のチャットを選択・削除・新規作成できる。ブラウザのデータを消去すると履歴も
  消えるので注意（サーバー側やファイルには保存されない）。

## トラブルシューティング

- 「Ollamaに接続できませんでした」と表示される場合は、`ollama serve`（または
  `docker compose ps` で `ollama` コンテナ）が起動しているか、`OLLAMA_HOST` の値が
  正しいかを確認してください。
- モデルが見つからないエラーが出る場合は `ollama list`（Docker の場合
  `docker compose exec ollama ollama list`）で取得済みモデル名を確認し、
  `MODEL_NAME` を一致させてください。
