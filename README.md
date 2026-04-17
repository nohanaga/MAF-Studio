# MAF Studio

**Microsoft Agent Framework (MAF) の機能をブラウザーから手軽に試せるローカル Web スタジオ**です。  
Agent Skills を持つエージェントを作成し、Handoffs Orchestration を用いてマルチエージェントシステムとして UI から構築できます。また、スキルがエージェントのコンテキストをどのように拡充しているかをリアルタイムで把握できる可視化機能も備えています。

| タブ | できること |
|---|---|
| **Agents** | モデル・指示・Hosted MCP tools・Agent Skills を設定して保存、チャットテストの実施 |
| **Skills** | SKILL.md ベースのスキルの作成と編集、スクリプトをローカルで直接実行 |
| **Workflows** | `graph / sequential / concurrent / group-chat` パターンでマルチエージェントの実行フローを構築し、コード生成とテスト実行 |
| **Handoffs** | 参加エージェント・ハンドオフルールを定義し、グラフ確認とチャットテストを実施 |
| **Skill Visualization** | Handoff 実行中のスキルの advertise / load / Read resorces & Run scripts をリアルタイムで可視化 |


![GIF](assets/demo.gif)

---

## 1. Agent Skills とは

**[Agent Skills](https://learn.microsoft.com/en-us/agent-framework/agents/skills?pivots=programming-language-python)** は、エージェントに特定の業務能力を追加するための「再利用可能な知識・手順・ツールのパッケージ仕様」です。

スキルはフォルダ単位で定義します：

```
skill-name/
├── SKILL.md          ← 必須: スキル本体（YAML フロントマター ＋ マークダウン本文）
├── scripts/          ← 任意: 実行可能なコード
├── references/       ← 任意: 参照ドキュメント
└── assets/           ← 任意: テンプレート・画像等
```

- 最小構成は `SKILL.md` のみ
- 必要なときにだけ読み込むため、コンテキストを効率よく使える
- 業務知識・判断ルール・ツール呼び出し手順をパッケージとして再利用できる

---

## 2. Handoffs Orchestration とは

**[Handoffs Orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff?pivots=programming-language-python)** は、ユーザーのリクエスト内容に応じて適切な専門エージェントへ会話を動的に引き継ぐ（Handoff）仕組みです。  
各エージェントは Agent Skills を通じて業務知識を持ち、問い合わせに応じて最適なエージェントが処理を担当します。



**特徴：**
- 専門領域ごとのエージェント分担
- 会話内容に基づく動的なルーティング
- 会話セッションを共有しシームレスな会話体験を実現

---

## 3. セットアップ＆起動

環境に合わせて手順を選んでください。

---

### ▶ GitHub Codespaces（推奨）

インストール不要でブラウザーからすぐ始められます。

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/matayuuu/MAF-Studio?quickstart=1)

1. 上のバッジをクリックして Codespace を作成します
2. コンテナ起動後、依存関係のインストールと `.env` ファイルの作成が自動で行われます

   > **自動セットアップが失敗した場合** は手動で実行してください:
   >
   > ```bash
   > python -m pip install -r requirements.txt
   > cp .env.example .env
   > ```

3. `.env` を編集して、使用するモデルプロバイダーの値を設定します（→ [モデル接続](#モデル接続) 参照）

4. Azure OpenAI / Azure AI Foundry を使う場合はターミナルで認証します

   ```bash
   az login --use-device-code
   ```

5. `Ctrl+Shift+P` → **Tasks: Run Task** からサーバーを起動します

   | タスク | 説明 |
   |---|---|
   | **Start MAF Studio** | MAF Studio をポート 8000 で起動 |
   | **Start Demo CRM App** | デモ用 CRM アプリをポート 8001 で起動 |
   | **Start All Servers** | 両サーバーを並列起動 |

   ポート 8000 が自動的にブラウザに転送されて開きます。

---

### ▶ ローカル環境

Python 3.10+ と Git がインストール済みであることを確認してください。

**① 仮想環境を作成して有効化**

```bash
cd MAF-Studio
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate
```

**② 依存関係をインストールして `.env` を作成**

```bash
pip install -r requirements.txt
cp .env.example .env
```

`.env` を編集して、使用するモデルプロバイダーの値を設定します（→ [モデル接続](#モデル接続) 参照）

**③ Azure OpenAI / Azure AI Foundry を使う場合は認証**

```bash
az login --use-device-code
```

**④ サーバーを起動**

```bash
uvicorn app.main:app --reload
```

ブラウザーで `http://127.0.0.1:8000` を開きます。

---

### モデル接続

> モデルを設定しなくてもモック実行で UI のテストが可能です。

`.env` に必要な値を設定してください。

| プロバイダー | 必要な環境変数 |
|---|---|
| OpenAI Responses | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_ENDPOINT` |
| Azure AI Foundry | `AZURE_AI_PROJECT_ENDPOINT`（認証は `az login` または `DefaultAzureCredential`） |

---

## 4. デモシナリオを試す

MAF Studio には、すぐに試せる **Contoso 保険コンタクトセンター** シナリオが同梱されています。  
プリインストールエージェント・ハンドオフ設定・具体的な試し方は **[docs/DEMO.md](docs/DEMO.md)** をご覧ください。

---

## ご利用にあたって

> **注意**: スキルスクリプトはサーバーを実行しているマシン上でローカル実行されます。本リポジトリはデモ・プロトタイプ用途を想定しており、本番環境への直接利用は推奨しません。

## ライセンス

[MIT License](LICENSE)

## 参考リンク

- [Agent Skills — Microsoft Learn](https://learn.microsoft.com/ja-jp/agent-framework/agents/skills?pivots=programming-language-python)
- [Handoff Orchestration — Microsoft Learn](https://learn.microsoft.com/ja-jp/agent-framework/workflows/orchestrations/handoff?pivots=programming-language-python)
- [Sequential Orchestration — Microsoft Learn](https://learn.microsoft.com/ja-jp/agent-framework/workflows/orchestrations/sequential?pivots=programming-language-python)
- [Concurrent Orchestration — Microsoft Learn](https://learn.microsoft.com/ja-jp/agent-framework/workflows/orchestrations/concurrent?pivots=programming-language-python)
- [Group Chat Orchestration — Microsoft Learn](https://learn.microsoft.com/ja-jp/agent-framework/workflows/orchestrations/group-chat?pivots=programming-language-python)

