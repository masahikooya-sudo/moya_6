# Kubernetes(IDCFクラウド コンテナ)への社内向けデプロイ手順

既存のKubernetesクラスタ(IDCFクラウド コンテナ / Rancher など、`kubectl` で接続できる
クラスタ)に Local Gemma Chat をデプロイする手順です。[DEPLOY_IDCF.md](./DEPLOY_IDCF.md)
(仮想マシン1台にDocker Composeでデプロイする方法)と同じく、社内ネットワーク/VPN限定 +
Google Workspaceアカウントでのログインが必要な構成にします。

## 前提

- `kubectl` でクラスタに接続できること(`kubectl cluster-info` で確認)
- クラスタにイメージをpushできるコンテナレジストリ(Docker Hubのプライベートリポジトリ、
  GitHub Container Registry等)
- クラスタにIngressコントローラーが入っていること(Rancherのデフォルト構成では
  NGINX Ingressが入っていることが多いです。`kubectl get pods -A | grep ingress` で確認)
- Ollama用ノードはCPUのみを想定(GPUノードを使う場合は末尾の「GPUノードを使う場合」を参照)

マニフェストは `k8s/` ディレクトリにまとめてあります。

```
k8s/
├── 00-namespace.yaml
├── 01-configmap.yaml           # 機密でない設定値
├── 02-secret.example.yaml      # Secretのテンプレート(そのままapplyしない)
├── 03-ollama-pvc.yaml          # モデルデータ永続化用PVC
├── 04-ollama-deployment.yaml   # Ollama(CPUのみ、ホスト非公開)
├── 05-ollama-service.yaml
├── 06-app-deployment.yaml      # このリポジトリのExpressサーバー
├── 07-app-service.yaml
├── 08-oauth2-proxy-deployment.yaml  # Google WorkspaceログインでSSO
├── 09-oauth2-proxy-service.yaml
└── 10-ingress.yaml             # TLS終端 + 社内/VPN IPのみ許可
```

## 1. アプリのコンテナイメージをビルド・push する

```bash
docker build -t <レジストリ>/local-gemma-chat:latest .
docker push <レジストリ>/local-gemma-chat:latest
```

`k8s/06-app-deployment.yaml` の `image: <YOUR_REGISTRY>/local-gemma-chat:latest` を
実際のイメージ名に書き換えてください。プライベートレジストリの場合は認証情報を
Secretとして作成し、Deployment内の `imagePullSecrets` のコメントを外してください。

```bash
kubectl -n local-gemma-chat create secret docker-registry regcred \
  --docker-server=<レジストリ> --docker-username=<ユーザー名> --docker-password=<パスワード>
```

## 2. Google Workspace用のOAuthクライアントを作成する

[DEPLOY_IDCF.md の「5. Google Workspace用のOAuthクライアントを作成する」](./DEPLOY_IDCF.md#5-google-workspace用のoauthクライアントを作成する)
と同じ手順です。リダイレクトURIは、後述の`10-ingress.yaml`で設定するホスト名を使って
`https://<ホスト名>/oauth2/callback` としてください。

## 3. Namespace・ConfigMap・Secretを作成する

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
```

`k8s/01-configmap.yaml` の以下の値は実環境に合わせて編集してください。

- `ALLOWED_EMAIL_DOMAIN`: ログインを許可する自社のGoogle Workspaceドメイン
- `OAUTH2_PROXY_REDIRECT_URL`: 手順2で登録したリダイレクトURI
- `MODEL_NAME`: 使用するGemmaモデルのタグ(CPUのみなら軽量な`gemma4:e4b`等を推奨)

Secretは `k8s/02-secret.example.yaml` を直接applyせず、コマンドラインで作成してください
(リポジトリに秘密情報を残さないため)。

```bash
kubectl -n local-gemma-chat create secret generic app-secrets \
  --from-literal=GOOGLE_CLIENT_ID='<Google CloudのクライアントID>' \
  --from-literal=GOOGLE_CLIENT_SECRET='<Google Cloudのクライアントシークレット>' \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(python3 -c 'import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())')"
```

## 4. TLS証明書のSecretを作成する

[DEPLOY_IDCF.md の「6. TLS証明書を用意する」](./DEPLOY_IDCF.md#6-tls証明書を用意する)と
同様、社内/VPN限定でインターネットから到達できない場合はLet's Encryptの標準的な自動発行
(HTTP-01)が使えないことが多いため、社内CA/DNS-01チャレンジ/既存リバースプロキシの
いずれかで証明書を用意してください。クラスタに [cert-manager](https://cert-manager.io/)
が導入済みであれば、DNS-01チャレンジによる自動更新に置き換えることもできます。

```bash
kubectl -n local-gemma-chat create secret tls app-tls \
  --cert=fullchain.pem --key=privkey.pem
```

## 5. マニフェストを適用する

```bash
kubectl apply -f k8s/03-ollama-pvc.yaml
kubectl apply -f k8s/04-ollama-deployment.yaml
kubectl apply -f k8s/05-ollama-service.yaml
kubectl apply -f k8s/06-app-deployment.yaml
kubectl apply -f k8s/07-app-service.yaml
kubectl apply -f k8s/08-oauth2-proxy-deployment.yaml
kubectl apply -f k8s/09-oauth2-proxy-service.yaml
```

`k8s/10-ingress.yaml` は以下を実環境に合わせて編集してから適用してください。

- `host` / `tls.hosts`: 社員がアクセスするホスト名
- `nginx.ingress.kubernetes.io/whitelist-source-range`: 社内ネットワーク/VPNのCIDR
  (**ここを実際の値にしないと、Ingressに到達できる全員がアクセスできてしまいます**)

```bash
kubectl apply -f k8s/10-ingress.yaml
```

まとめて適用したい場合は `kubectl apply -f k8s/` でも構いませんが、Secret・TLS証明書・
イメージ名・ConfigMapの値は事前に上記の手順で用意/編集しておく必要があります。

## 6. Gemmaモデルを取得する(初回のみ)

```bash
kubectl -n local-gemma-chat exec -it deploy/ollama -- ollama pull gemma4
```

## 7. 動作確認

```bash
# Podが起動しているか
kubectl -n local-gemma-chat get pods

# appからollamaに到達できるか
kubectl -n local-gemma-chat exec deploy/app -- wget -qO- http://ollama:11434/api/tags
```

- 社内ネットワーク/VPNに接続した状態でブラウザから `https://<設定したホスト名>` に
  アクセスし、Googleログイン画面にリダイレクトされ、許可したドメインのアカウントで
  ログインできることを確認する
- 許可していないドメインのアカウントでログインを試み、拒否されることを確認する
- 社内ネットワーク外(VPN未接続、または`whitelist-source-range`外のIP)からは
  そもそも接続できないことを確認する

## GPUノードを使う場合

応答速度を優先してGPUノードに切り替える場合は、`k8s/04-ollama-deployment.yaml` に
以下を追加し、GPUを持つノードに割り当てられるよう `nodeSelector` 等を設定してください
(クラスタ側にNVIDIA device pluginの導入が別途必要です)。

```yaml
resources:
  limits:
    nvidia.com/gpu: 1
```

## 運用メモ

- **アップデート**: 新しいイメージをbuild・push後、
  `kubectl -n local-gemma-chat rollout restart deploy/app`
- **ログ確認**: `kubectl -n local-gemma-chat logs -f deploy/app`(`ollama` /
  `oauth2-proxy` も同様)
- **スケール**: `app` は複数レプリカに増やせます(`kubectl scale deploy/app --replicas=2`)。
  `ollama` はPVCが`ReadWriteOnce`のため複数レプリカにはできません(GPUノード込みで
  高可用性が必要な場合は構成の見直しが必要です)。
- **アップロードファイル**: Docker版と同様、アップロードしたファイルや検出結果は
  サーバー・ディスクには保存されません。
- **チューニング**: 応答が遅い/タイムアウトする場合は `k8s/01-configmap.yaml` の
  `OLLAMA_NUM_PREDICT` / `PII_CHUNK_CHAR_LIMIT` / `OLLAMA_TIMEOUT_MS` や、
  軽量モデル(`gemma4:e2b` / `gemma4:e4b`)への切り替えを検討してください
  (詳細はREADMEの「トラブルシューティング」を参照)。
