#!/usr/bin/env bash
set -euo pipefail

echo "=== MAF Studio: Codespaces セットアップ ==="

# 依存関係のインストール
echo "→ Python パッケージをインストール中..."
python -m pip install -r requirements.txt

# .env ファイルのセットアップ
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "→ .env.example を .env にコピーしました"
  echo "  .env を編集して API キーなどの値を設定してください"
else
  echo "→ .env は既に存在します (スキップ)"
fi

echo "=== セットアップ完了 ==="
echo ""
echo "起動方法:"
echo "  MAF Studio  → Ctrl+Shift+P > 'Tasks: Run Task' > 'Start MAF Studio'"
echo "  Demo CRM    → Ctrl+Shift+P > 'Tasks: Run Task' > 'Start Demo CRM App'"
