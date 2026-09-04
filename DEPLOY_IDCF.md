# IDCFクラウドへの社内向けデプロイ手順

Local Gemma Chat を IDCFクラウド上の仮想マシンにデプロイし、社内ネットワーク/VPN経由でのみ、
Google Workspaceアカウントでログインした社員だけがアクセスできるようにするための手順です。

## 前提とする構成

```
社員のブラウザ
   │ (社内ネットワーク/VPN経由のみ、インターネットには公開しない)
   ▼
IDCFクラウド 仮想マシン
   │
   ├─ oauth2-proxy(443番ポート、TLS終端 + Google Workspaceログイン)
   │      │ ログイン済みユーザーのみ転送
   │      ▼
   ├─ app(このリポジトリのExpressサーバー、社外には公開しない)
   │      │
   └─ ollama(Gemmaモデルの推論、社外には公開しない)
```

- ネットワークレベル: IDCFクラウドのファイアウォールで社内固定IP/VPNのIPレンジ以外からの
  アクセスを遮断する
- 認証レベル: `oauth2-proxy` が Google Workspace(OIDC)でログインさせ、指定ドメインの
  アカウント以外は弾く

この2段構えにすることで、VPNに接続していても本人のGoogleアカウントでのログインが必要になり、
「誰がいつアクセスしたか」も追跡できます。

## 1. IDCFクラウドで仮想マシンを作成する

- OS: Ubuntu 22.04 LTS などのLinuxテンプレート
- スペック目安(コスト優先・CPUのみ、Gemma 4 の `e2b`/`e4b` を想定):
  - vCPU: 8コア程度
  - メモリ: 16GB以上(モデルサイズ約7〜10GB + OS/アプリのオーバーヘッド)
  - ディスク: 50GB以上(OS + Dockerイメージ + モデルデータ)
  - 利用者数や同時アクセス数が多い場合はさらに上のプランを検討してください
  - 最新のプラン一覧・料金は [IDCFクラウド料金ページ](https://www.idcf.jp/cloud/price.html) で確認してください
- GPUが必要になった場合は東日本リージョン2の GPU BOOSTタイプ(Tesla P100/M40)への
  変更も可能です(応答速度は大きく向上しますが月額上限が高くなります)

## 2. ネットワーク/ファイアウォールを設定する

IDCFクラウドのファイアウォールは初期状態で全拒否です。IPアドレスに対して以下を許可してください。

| 用途 | ポート | 許可元 |
| --- | --- | --- |
| SSH管理 | 22 | 運用担当者のIPのみ |
| アプリ(HTTPS) | 443 | 社内ネットワーク/VPNのIPレンジのみ |

- 11434(Ollama)や3000(アプリ直接)は**外部に一切公開しない**でください。この構成では
  `docker-compose.prod.yml` によりホストにポートを公開しないため、意識せず安全になります。
- 設定方法は [IDCFクラウド ファイアウォール設定ガイド](https://www.idcf.jp/help/cloud/guide/fw.html) を参照してください。
- 社内から直接アクセスできない場合は、IDCFクラウドとオフィス/VPN間の閉域接続(プライベート
  コネクト等)の利用を検討してください。

## 3. Docker / Docker Compose を導入する

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # 再ログインして反映
```

## 4. リポジトリを配置する

```bash
git clone <このリポジトリのURL>
cd moya_6
```

## 5. Google Workspace用のOAuthクライアントを作成する

1. [Google Cloud Console](https://console.cloud.google.com/) で新しいプロジェクト(または既存プロジェクト)を開く
2. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」
3. アプリケーションの種類: 「ウェブアプリケーション」
4. 「承認済みのリダイレクトURI」に以下を追加(社員がアクセスするURLに合わせる)
   ```
   https://<社内向けドメインまたはIP>/oauth2/callback
   ```
5. 発行された「クライアントID」「クライアントシークレット」を控える
6. OAuth同意画面で「ユーザーの種類」を「Workspace内部(Internal)」にできる場合は、
   自社ドメインのアカウントのみに自動的に限定されるため推奨です

## 6. TLS証明書を用意する

社内/VPN限定でインターネットから到達できないため、Let's Encryptの標準的な自動発行
(HTTP-01チャレンジ)は使えないことが多いです。以下のいずれかで用意してください。

- **社内CA/自己署名証明書**: 社内で証明書を発行し、社員のPCに信頼済みルート証明書として配布する
- **DNS-01チャレンジ**: 利用中のDNSプロバイダがAPI対応していれば、`certbot`のDNSプラグインで
  ポート80を公開せずにLet's Encrypt証明書を取得できる
- **既存の社内リバースプロキシ/ロードバランサ**でTLS終端を行い、そこからこのVMへは
  プレーンHTTPで中継する(その場合は `oauth2-proxy` のTLS設定を外し、HTTPのまま
  `ports: "443:4180"` を `"8443:4180"` 等の内部ポートに変更してください)

取得した証明書を以下のように配置してください。

```bash
mkdir -p certs
cp fullchain.pem certs/
cp privkey.pem certs/
```

## 7. 環境変数を設定する

```bash
cp .env.production.example .env.production
```

`.env.production` を編集し、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`OAUTH2_PROXY_COOKIE_SECRET` / `ALLOWED_EMAIL_DOMAIN` / `OAUTH2_PROXY_REDIRECT_URL` を
実際の値に設定してください(ファイル内にコメントで詳細を記載しています)。

`OAUTH2_PROXY_COOKIE_SECRET` は以下のコマンドで生成できます。

```bash
python3 -c "import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```

## 8. 起動する

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Gemmaモデルを取得します(初回のみ)。

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec ollama ollama pull gemma4
```

## 9. 動作確認

- 社内ネットワーク/VPNに接続した状態でブラウザから `https://<設定したドメイン>` にアクセスする
- Googleログイン画面にリダイレクトされ、許可したドメインのアカウントでログインできることを確認する
- 許可していないドメインのGoogleアカウントでログインを試み、拒否されることを確認する
- 社内ネットワーク外(VPN未接続)からはそもそも接続できないことを確認する

## 運用メモ

- **アップデート**: `git pull` 後に `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
- **ログ確認**: `docker compose -f docker-compose.prod.yml logs -f app` / `oauth2-proxy` / `ollama`
- **モデルデータ**: `ollama_data` という名前付きボリュームに保存されるため、コンテナ再作成後も
  再ダウンロード不要です
- **会話履歴**: このアプリは会話履歴を各社員のブラウザの localStorage にのみ保存します。
  サーバー側での保存・監査ログは行っていないため、利用状況の監査が必要な場合は
  `oauth2-proxy` のアクセスログ(誰がいつログインしたか)を別途保管・監視する運用を
  検討してください。
- **個人情報チェック機能**: アップロードしたファイルはメモリ上でのみ処理され、ディスクや
  外部に保存されません。ただし全社員が同じVMを共有するため、機密ファイルの取り扱いに
  ついては社内ポリシーを別途整備してください。
