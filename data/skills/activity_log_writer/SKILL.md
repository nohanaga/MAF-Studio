---
name: activity-log-writer
description: 顧客対応の活動記録を activities.csv に書き込む。
---

# Skill: activity_log_writer

## 目的
顧客対応の結果を activities.csv に記録する。対応終了時に必ず呼び出すこと。

## エージェントが使う判断ルール
- **1スレッド（1会話）につき記録は1件のみ**。同一スレッド内で複数のアクション（提案→見積→契約など）が発生しても、最終アクション1件だけを記録する
- 例: 「見積案内 → 新規契約」の会話 → 「新規契約完了」1件のみ記録（見積段階では記録しない）
- 例: 「情報提供のみで完了」の会話 → 「情報提供」1件を記録
- 次回アクション（next_action）と次回アクション日（next_action_date）も必ず記入する
- 結果（outcome）は以下から選択: 契約完了/解約完了/要フォロー/提案済み/情報提供/継続フォロー/対応不要

## 業務上の暗黙知
- activity_typeは「電話」「訪問」「チャット」「システム」から選択
- **agent_nameは、このスキルを呼び出しているエージェント自身の名前を使う**
  - 生命保険エージェントが呼び出す場合: `"LifeInsuranceAgent"`
  - 自動車保険エージェントが呼び出す場合: `"AutoInsuranceAgent"`
  - フロントエージェントが呼び出す場合: `"FrontAgent"`
  - FrontAgentが商談を起票することは原則なく、専門エージェントが記録する
- contentには会話の要点と結論を簡潔に記入する

## 使用するスクリプト
- `scripts/write_activity.py` — 活動履歴の追記

## 使用するデータ
- `demo_app/data/activities.csv`
