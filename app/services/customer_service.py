"""
customer_service.py — Pure-Python customer profile lookup for the Studio API.

Reads data from demo_app/data/ CSV files without subprocess.
"""
from __future__ import annotations

import csv
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parents[2] / "demo_app" / "data"


def _load_csv(name: str) -> list[dict]:
    path = _DATA_DIR / name
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def get_customer_profile(customer_id: str) -> dict | None:
    """Return full customer profile or None if not found.

    Response shape mirrors profile_summary.py so that ``update_context_from_output``
    can parse it directly.
    """
    customer_id = (customer_id or "").strip()
    if not customer_id:
        return None

    customers = _load_csv("customers.csv")
    customer = next((r for r in customers if r.get("customer_id", "").strip() == customer_id), None)
    if customer is None:
        return None

    contracts = _load_csv("contracts.csv")
    products = _load_csv("products.csv")
    activities = _load_csv("activities.csv")

    product_map = {p["product_id"]: p["product_name"] for p in products}

    all_contracts = [
        {
            "contract_id": c["contract_id"],
            "product_id": c.get("product_id", ""),
            "product_name": product_map.get(c["product_id"], c.get("product_id", "")),
            "contract_date": c.get("contract_date", ""),
            "start_date": c.get("start_date", ""),
            "end_date": c.get("end_date", ""),
            "contract_status": c.get("contract_status", ""),
            "monthly_premium": c.get("monthly_premium", ""),
            "coverage_amount": c.get("coverage_amount", ""),
            "payment_method": c.get("payment_method", ""),
            "insured_name": c.get("insured_name", ""),
            "beneficiary_name": c.get("beneficiary_name", ""),
            "beneficiary_relation": c.get("beneficiary_relation", ""),
            "next_review_date": c.get("next_review_date", ""),
            "notes": c.get("notes", ""),
        }
        for c in contracts
        if c.get("customer_id", "").strip() == customer_id
    ]

    recent_activities = sorted(
        [a for a in activities if a.get("customer_id", "").strip() == customer_id],
        key=lambda x: x.get("activity_date", ""),
        reverse=True,
    )[:5]

    income = int(customer.get("annual_income") or 0)
    age = int(customer.get("age") or 0)
    if income >= 10_000_000:
        segment = "富裕層"
    elif age >= 60:
        segment = "リタイア層"
    else:
        segment = "中間層"

    total_premium = sum(
        int(c["monthly_premium"]) for c in all_contracts if c["monthly_premium"].isdigit() or
        (c["monthly_premium"].replace("-", "").isdigit() and c["monthly_premium"])
    )

    return {
        "customer": {
            "customer_id": customer["customer_id"],
            "full_name": f"{customer.get('last_name', '')} {customer.get('first_name', '')}".strip(),
            "last_name": customer.get("last_name", ""),
            "first_name": customer.get("first_name", ""),
            "age": customer.get("age", ""),
            "gender": customer.get("gender", ""),
            "birth_date": customer.get("birth_date", ""),
            "phone": customer.get("phone", ""),
            "email": customer.get("email", ""),
            "prefecture": customer.get("prefecture", ""),
            "city": customer.get("city", ""),
            "occupation": customer.get("occupation", ""),
            "annual_income": customer.get("annual_income", ""),
            "segment": segment,
            "assigned_agent": customer.get("assigned_agent", ""),
            "last_contact_date": customer.get("last_contact_date", ""),
            "notes": customer.get("notes", ""),
        },
        "contracts": {
            "count": len(all_contracts),
            "total_monthly_premium": total_premium,
            "items": all_contracts,
        },
        "recent_activities": recent_activities,
    }
