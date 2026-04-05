"""
Tests for customer_context capture and propagation in handoff_runtime.

Covers:
  - update_context_from_output() helper (unit tests)
  - HandoffSession.customer_context populated across agents (integration)
  - customer_context included in done SSE event
  - customer_context propagated to receiving agent on handoff
"""
from __future__ import annotations

import json
import pytest

from app.models import HandoffSession
from app.services.handoff_runtime import (
    update_context_from_output,
    get_or_create_session,
    get_session,
    clear_session,
)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Unit tests: update_context_from_output()
# ══════════════════════════════════════════════════════════════════════════════

class TestUpdateContextFromOutput:

    def test_flat_customer_lookup_result(self):
        """lookup_by_id / lookup_by_name の直接JSONをパース。"""
        fn_output = json.dumps({
            "customer_id": "C016",
            "full_name": "又吉 佑樹",
            "prefecture": "沖縄県",
        })
        ctx: dict = {}
        changed = update_context_from_output(fn_output, ctx)

        assert changed is True
        assert ctx["customer_id"] == "C016"
        assert ctx["full_name"] == "又吉 佑樹"
        assert ctx["prefecture"] == "沖縄県"  # prefecture は取り込まれる

    def test_list_result_takes_first_item(self):
        """lookup_by_name はリストを返す。先頭要素を取得すること。"""
        fn_output = json.dumps([
            {"customer_id": "C016", "full_name": "又吉 佑樹"},
            {"customer_id": "C001", "full_name": "田中 健太"},
        ])
        ctx: dict = {}
        changed = update_context_from_output(fn_output, ctx)

        assert changed is True
        assert ctx["customer_id"] == "C016"
        assert ctx["full_name"] == "又吉 佑樹"

    def test_profile_summary_nested_customer(self):
        """customer_profile_summary は customer: {} ネストを持つ。"""
        fn_output = json.dumps({
            "customer": {
                "customer_id": "C016",
                "full_name": "又吉 佑樹",
            },
            "contracts": {"items": []},
        })
        ctx: dict = {}
        changed = update_context_from_output(fn_output, ctx)

        assert changed is True
        assert ctx["customer_id"] == "C016"
        assert ctx["full_name"] == "又吉 佑樹"

    def test_contracts_first_item_captured(self):
        """contracts.items[0] から contract_id / product_name を取得する。"""
        fn_output = json.dumps({
            "customer": {"customer_id": "C016", "full_name": "又吉 佑樹"},
            "contracts": {
                "items": [
                    {"contract_id": "CT008", "product_name": "ファミリー定期保険"},
                    {"contract_id": "CT999", "product_name": "別の保険"},
                ]
            },
        })
        ctx: dict = {}
        update_context_from_output(fn_output, ctx)

        assert ctx["contract_id"] == "CT008"
        assert ctx["product_name"] == "ファミリー定期保険"

    def test_contract_not_overwritten_if_already_set(self):
        """contract_id が既に ctx にあるとき、setdefault によりフラットキーは上書きされない。"""
        fn_output = json.dumps({
            "contracts": {"items": [{"contract_id": "CT999", "product_name": "新しい保険"}]},
        })
        ctx = {"contract_id": "CT008", "product_name": "ファミリー定期保険"}
        update_context_from_output(fn_output, ctx)

        assert ctx["contract_id"] == "CT008"   # setdefault で上書きされていない
        # contracts リスト自体は更新される
        assert ctx["contracts"][0]["contract_id"] == "CT999"

    def test_no_match_returns_false(self):
        """顧客情報を含まないJSONはchanged=Falseを返す。"""
        fn_output = json.dumps({"status": "ok", "rows_updated": 1})
        ctx: dict = {}
        changed = update_context_from_output(fn_output, ctx)

        assert changed is False
        assert ctx == {}

    def test_profile_summary_captures_activities(self):
        """profile_summary の recent_activities をリストとして取り込む。"""
        fn_output = json.dumps({
            "customer": {"customer_id": "C016", "full_name": "又吉 佑樹"},
            "contracts": {"items": [{"contract_id": "CT008", "product_name": "バランス総合保険", "monthly_premium": "8500", "contract_status": "有効"}]},
            "recent_activities": [
                {"activity_date": "2026-03-31", "activity_type": "初回面談", "subject": "保険見直しヒアリング", "outcome": "継続フォロー"},
            ],
        })
        ctx: dict = {}
        changed = update_context_from_output(fn_output, ctx)

        assert changed is True
        assert isinstance(ctx.get("contracts"), list)
        assert ctx["contracts"][0]["contract_id"] == "CT008"
        assert isinstance(ctx.get("activities"), list)
        assert ctx["activities"][0]["activity_type"] == "初回面談"

    def test_last_first_name_compose_full_name(self):
        """last_name + first_name が存在するとき full_name に合成する。"""
        fn_output = json.dumps({
            "customer_id": "C016",
            "last_name": "又吉",
            "first_name": "佑樹",
        })
        ctx: dict = {}
        update_context_from_output(fn_output, ctx)
        assert ctx["full_name"] == "又吉 佑樹"

    def test_invalid_json_returns_false(self):
        """不正JSONでも例外を投げずFalseを返す。"""
        ctx: dict = {}
        changed = update_context_from_output("not json {{{", ctx)

        assert changed is False
        assert ctx == {}

    def test_empty_string_returns_false(self):
        ctx: dict = {}
        changed = update_context_from_output("", ctx)
        assert changed is False

    def test_existing_values_not_cleared(self):
        """ctx に既存の値がある場合、新しい結果で追記される。"""
        ctx = {"customer_id": "C016", "full_name": "又吉 佑樹"}
        fn_output = json.dumps({"contract_id": "CT008"})
        update_context_from_output(fn_output, ctx)

        assert ctx["customer_id"] == "C016"
        assert ctx["contract_id"] == "CT008"

    def test_empty_field_is_ignored(self):
        """空文字のフィールドは取り込まない。"""
        fn_output = json.dumps({"customer_id": "", "full_name": "又吉 佑樹"})
        ctx: dict = {}
        update_context_from_output(fn_output, ctx)

        assert "customer_id" not in ctx
        assert ctx["full_name"] == "又吉 佑樹"


# ══════════════════════════════════════════════════════════════════════════════
# 2. Integration tests: HandoffSession 経由での customer_context 動作
# ══════════════════════════════════════════════════════════════════════════════

class TestHandoffSessionCustomerContext:

    def test_session_starts_with_empty_context(self):
        sess = HandoffSession(handoff_id="test-hid")
        assert sess.customer_context == {}

    def test_context_updated_then_persists(self):
        """customer_context への書き込みがセッション内で永続する。"""
        sess = HandoffSession(handoff_id="test-hid")
        update_context_from_output(
            json.dumps({"customer_id": "C016", "full_name": "又吉 佑樹"}),
            sess.customer_context,
        )
        assert sess.customer_context["customer_id"] == "C016"
        assert sess.customer_context["full_name"] == "又吉 佑樹"

    def test_context_accumulates_across_multiple_results(self):
        """複数のスキル結果にわたって context が積み上がる。"""
        sess = HandoffSession(handoff_id="test-hid")

        # turn 1: customer lookup
        update_context_from_output(
            json.dumps({"customer_id": "C016", "full_name": "又吉 佑樹"}),
            sess.customer_context,
        )
        # turn 2: contract lookup
        update_context_from_output(
            json.dumps({"contract_id": "CT008", "product_name": "ファミリー定期保険"}),
            sess.customer_context,
        )

        assert sess.customer_context["customer_id"] == "C016"
        assert sess.customer_context["contract_id"] == "CT008"
        assert sess.customer_context["product_name"] == "ファミリー定期保険"

    def test_get_or_create_session_stores_in_registry(self):
        sess = get_or_create_session("hid-001", None, "agent-front")
        found = get_session(sess.session_id)
        assert found is sess
        clear_session(sess.session_id)  # cleanup

    def test_context_shared_between_agents_in_same_session(self):
        """同一セッション内では customer_context がエージェントをまたいで共有される。"""
        sess = get_or_create_session("hid-002", None, "agent-front")
        # フロントエージェントが customer 情報を書き込む
        update_context_from_output(
            json.dumps({"customer_id": "C016", "full_name": "又吉 佑樹"}),
            sess.customer_context,
        )
        # ハンズオフ後に別エージェントが同じセッション参照で context を読める
        fetched = get_session(sess.session_id)
        assert fetched is not None
        assert fetched.customer_context["customer_id"] == "C016"
        clear_session(sess.session_id)  # cleanup


# ══════════════════════════════════════════════════════════════════════════════
# 3. SSE done イベントへの customer_context 埋め込み確認
#    (handoff_runtime の _sse helper を直接テスト)
# ══════════════════════════════════════════════════════════════════════════════

def test_done_event_includes_customer_context():
    """done イベントの payload に customer_context が含まれること。"""
    from app.services.handoff_runtime import _sse
    import json as _json

    ctx = {"customer_id": "C016", "full_name": "又吉 佑樹", "contract_id": "CT008"}
    sse_line = _sse("done", {
        "agent_id": "agent-front",
        "agent_name": "フロントエージェント",
        "text": "テスト",
        "session_id": "hs-test",
        "current_agent_id": "agent-front",
        "is_complete": False,
        "customer_context": ctx,
    })

    # SSE フォーマット: "event: done\ndata: {...}\n\n"
    assert "event: done" in sse_line
    data_line = [l for l in sse_line.split("\n") if l.startswith("data: ")][0]
    payload = _json.loads(data_line[6:])
    assert payload["customer_context"]["customer_id"] == "C016"
    assert payload["customer_context"]["full_name"] == "又吉 佑樹"
    assert payload["customer_context"]["contract_id"] == "CT008"
