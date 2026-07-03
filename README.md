# すぐタク

シニア向けデータ配車プラットフォーム「すぐタク」

## 構成

- [`backend/`](backend) — 配車マッチングのコアロジック（TypeScript / `SuguTakuMatchingEngine`）
- [`frontend/`](frontend) — タクシー運転手向け車載ナビ画面のPoCデモ（単一HTML、Tailwind CSS）

## backend

```
cd backend
npm install
npm run build   # 型チェック＋コンパイル
npm run demo    # デモシナリオを実行
```

## frontend

`frontend/index.html` をブラウザで直接開くか、簡易サーバーで配信してください。

```
cd frontend
npx http-server -p 5544
```
