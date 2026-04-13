# MAF Studio

**Microsoft Agent Framework 向けのローカル Web スタジオ**です。エージェントの設計からマルチエージェント実行・スキル動作の可視化まで、1 つの UI で完結します。

### 主な機能

| タブ | 概要 |
|---|---|
| **Agents** | model / instructions / Hosted MCP tools / Agent Skills を設定・保存 |
| **Skills** | SKILL.md ベースのスキルをアップロードし、スクリプトをローカルで直接実行 |
| **Handoffs** | 参加 agent・ハンドオフルールを定義し、エージェントメッシュをグラフで確認・チャットでテスト |
| **Skill Visualization** | Handoff 実行中の skills の advertise / load / execute をリアルタイムで可視化 |

---

## 1. セットアップ

### GitHub Codespaces（推奨）

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/matayuuu/MAF-Studio?quickstart=1)

1. 上のバッジをクリックして Codespace を作成
2. コンテナ起動後、依存関係は自動でインストールされます
3. `.env.example` を `.env` にコピーして、使用するプロバイダーの値を設定します

   ```bash
   cp .env.example .env
   # .env を編集して API キーなどを入力
   ```

4. Azure AI Foundry を使う場合はターミナルで認証します

   ```bash
   az login
   ```

5. サーバーを起動します

   ```
   Ctrl+Shift+P  →  Tasks: Run Task  →  Start MAF Studio
   ```

   ポート 8000 が自動的にブラウザに転送されて開きます。

### ローカル環境

```powershell
cd <repo_dir>
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`.env.example` を `.env` にコピーして、使用するプロバイダーの値を設定します。

---

## 2. 起動

### Codespaces

`Ctrl+Shift+P` → **Tasks: Run Task** から以下を選択します。

| タスク | 説明 |
|---|---|
| **Start MAF Studio** | MAF Studio をポート 8000 で起動 |
| **Start Demo CRM App** | デモ用 CRM アプリをポート 8001 で起動 |
| **Start All Servers** | 両サーバーを並列起動 |

### ローカル環境

```powershell
cd <repo_dir>
.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

ブラウザーで `http://127.0.0.1:8000` を開きます。

---

## 3. モデル接続

モデルを設定しなくてもモック実行で UI のテストが可能です。

| プロバイダー | 必要な環境変数 |
|---|---|
| OpenAI Responses | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` |
| Azure AI Foundry | `AZURE_AI_PROJECT_ENDPOINT` + `az login` または `DefaultAzureCredential` |

---

## 4. Agent Skills の取り込み

Skills タブでスキルをアップロードして管理します。

- **フォルダ upload**: `SKILL.md` / `references/` / `scripts/` を含むスキルフォルダをそのまま登録
- **ファイル upload**: ファイル群をまとめて 1 つのスキルとして登録
- **スクリプト実行**: 右ペインの **Run selected skill script** から JSON 引数付きでローカル実行し、結果を確認

サンプルとして `data/skills/unit-converter` を同梱しています。

---

## 5. Handoff Orchestration

`HandoffBuilder` を使ったマルチエージェント会話セッションを設計・実行します。

1. **Handoffs** タブで開始 agent・参加 agent・ハンドオフルールを定義して保存
2. エージェントのルーティングをグラフで確認
3. チャット UI から会話を開始し、エージェント間のハンドオフと各 agent の応答をリアルタイムで確認

各 agent には Agent Skills と Hosted MCP tools を割り当て可能。agent 間で共有されるコンテキスト（`customer_context` など）はセッションを通じて保持されます。

---

## 6. Skill Visualization

Handoff 実行中の Agent Skills の動きをリアルタイムで可視化するダッシュボードです。

![Skill Visualization Demo](demo.gif)

- **Advertise**: 各 agent がターン開始時にどのスキルを提示したかを表示
- **Load**: LLM が `load_skill` を呼び出しスキルの詳細を取得したタイミングを追跡
- **Execute**: スキルスクリプトの実行とその結果を時系列で表示
- ハンドオフの流れをオーケストレーショングラフと合わせて確認

---

## 参考リンク

- [Agent skills](https://learn.microsoft.com/ja-jp/agent-framework/agents/skills?pivots=programming-language-python)