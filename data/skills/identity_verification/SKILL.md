---
name: identity-verification
description: Verify customer identity by confirming the customer ID exists in the database.
---

# Skill: identity_verification

## 目的
顧客IDの存在をデータベースで照合し、本人確認を行う。
`customer-lookup` で顧客情報が取得できた場合は、そちらの結果をそのまま本人確認完了として扱ってよい。
`customer-lookup` を使用しない場合や、顧客IDのみで照合したい場合にこのSkillを使用する。

## エージェントが使う判断ルール
- `customer-lookup` スキルで顧客が見つかった場合 → 本人確認完了（このSkillの実行は不要）
- 顧客IDのみで照合が必要な場合は `scripts/verify_identity.py` を実行する
- 顧客IDが存在した場合のみ「本人確認完了」とする
- 存在しない場合は「お客様情報が確認できません」と案内し、再度IDを確認する

## 業務上の暗黙知
- 本人確認は用件対応・専門エージェントへの転送の前提条件
- 本人確認完了後は必ず顧客に用件を伺い、転送ツールを呼び出すこと

## 使用するスクリプト
- `scripts/verify_identity.py` — 顧客IDの照合（引数: `customer_id`）

## 使用するデータ
- `demo_app/data/customers.csv`
