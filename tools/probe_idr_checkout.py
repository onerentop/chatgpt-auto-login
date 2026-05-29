#!/usr/bin/env python3
"""Phase 3 命门探针：验证印尼 IDR 结账链接是否走 Midtrans GoPay。
用法: 设 HTTPS_PROXY 为日本代理后:
    echo '{"access_token":"<真实IDR账号token>"}' | py -3 tools/probe_idr_checkout.py
观察输出: midtrans_url 是否非空。
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from checkout_link import extract_midtrans_url
from curl_cffi import requests as cr

def main():
    inp = json.loads(sys.stdin.read())
    token = inp['access_token']
    body = {
        "entry_point": "all_plans_pricing_modal",
        "plan_name": "chatgptplusplan",
        "billing_details": {"country": "ID", "currency": "IDR"},
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": "hosted",
        "promo_campaign": {"promo_campaign_id": "plus-1-month-free", "is_coupon_from_query_param": False},
    }
    r = cr.post(
        "https://chatgpt.com/backend-api/payments/checkout",
        json=body,
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
        impersonate='chrome131', timeout=30,
    )
    text = r.text
    print(f"HTTP {r.status_code}")
    print(f"pay.openai.com link: {'yes' if 'pay.openai.com' in text else 'NO'}")
    mt = extract_midtrans_url(text)
    print(f"midtrans_url (direct): {mt or 'NONE'}")
    print(f"--- first 800 chars ---\n{text[:800]}")

if __name__ == '__main__':
    main()
