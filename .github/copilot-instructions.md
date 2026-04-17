<!--
Official references:
- https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot
- https://docs.github.com/copilot/using-github-copilot/coding-agent/asking-copilot-to-create-a-pull-request
- https://docs.github.com/copilot/tutorials/use-custom-instructions
-->

# Repository instructions for GitHub Copilot

## Goal
この repository では、GitHub Copilot / cloud agent / IDE agents が、
**安全に変更し、検証し、PR を作成できること** を最優先とします。

## Project understanding
- まず `README.md`、`docs/`、`package.json` / `pyproject.toml` / `.csproj` などの主要構成を読んでください。
- 変更前に、既存のアーキテクチャ、命名規則、レイヤ分離、依存方向を確認してください。
- 不明な点がある場合は、既存コードのパターンを優先してください。

## Allowed changes
- 要件達成に必要な最小差分を優先してください。
- 大規模リファクタは、明示要求がない限り行わないでください。
- API 契約や DB スキーマを壊す変更は避けてください。

## Coding rules
- 既存の言語・フレームワークの慣例に従ってください。
- コメントよりも明確な命名を優先してください。
- 例外処理、入力検証、ログ出力を省略しないでください。
- セキュリティ、権限、秘密情報、入力値の扱いに注意してください。

## Validation rules
変更後は、可能な限り次を実行してください。

```bash
make validate
```

`make validate` が存在しない場合は、以下を検討してください。
- format
- lint
- typecheck
- unit test
- integration test または smoke test

## Pull request expectations
PR には以下を含めてください。
- 何を変更したか
- なぜ必要か
- 主な設計判断
- 実行した検証内容
- 未解決事項またはリスク

## Safety
- 秘密情報、鍵、接続文字列、トークンを生成・埋め込まないでください。
- CI が失敗している場合は、原因を説明してください。
- 推測で削除しないでください。不要コードの削除は影響範囲を確認した上で行ってください。
