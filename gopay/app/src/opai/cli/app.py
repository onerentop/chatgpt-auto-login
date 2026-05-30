from __future__ import annotations

import argparse
import json
import logging


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="opai", description="GoPay protocol automation (no browser)")
    parser.add_argument("--debug", action="store_true", help="enable debug logging")
    sub = parser.add_subparsers(dest="command")

    # === worker (protocol-based, no browser) ===
    p_worker = sub.add_parser("worker", help="GoPay protocol worker (register + pay)")
    worker_sub = p_worker.add_subparsers(dest="worker_command")

    p_w_run = worker_sub.add_parser("run", help="Start parallel register+pay worker threads")
    p_w_run.add_argument("--workers", type=int, default=3, help="Number of parallel workers")
    p_w_run.add_argument("--pin", default="147258", help="GoPay PIN to set")
    p_w_run.add_argument("--poll", type=float, default=10, help="Inbox poll interval (seconds)")
    p_w_run.add_argument("--api-key", default="", help="SMS API key (overrides config.json)")
    p_w_run.add_argument("--resume", nargs="+", metavar="PHONE", help="Resume from existing accounts")
    p_w_run.add_argument("--sms-provider", default="", help="SMS provider: herosms or smscloud")

    p_w_dry = worker_sub.add_parser("dry-run", help="Register one account only (no payment)")
    p_w_dry.add_argument("--pin", default="147258", help="GoPay PIN to set")
    p_w_dry.add_argument("--api-key", default="", help="SMS API key (overrides config.json)")
    p_w_dry.add_argument("--sms-provider", default="", help="SMS provider: herosms or smscloud")

    p_w_register = worker_sub.add_parser("register", help="Register a single GoPay account")
    p_w_register.add_argument("--pin", default="147258", help="GoPay PIN to set")
    p_w_register.add_argument("--api-key", default="", help="SMS API key (overrides config.json)")
    p_w_register.add_argument("--proxy", default="", help="Proxy URL")
    p_w_register.add_argument("--sms-provider", default="", help="SMS provider: herosms or smscloud")

    p_w_balance = worker_sub.add_parser("balance", help="Check balance of a saved account")
    p_w_balance.add_argument("phone", help="Phone number")
    p_w_balance.add_argument("--proxy", default="", help="Proxy URL")

    # === pay (protocol-based single payment test) ===
    p_pay = sub.add_parser("pay", help="Run a single protocol payment against Midtrans URL")
    p_pay.add_argument("midtrans_url", help="Midtrans snap redirect URL")
    p_pay.add_argument("--phone", required=True, help="GoPay local phone (no +62)")
    p_pay.add_argument("--pin", required=True, help="6-digit PIN")
    p_pay.add_argument("--proxy", default="", help="Proxy URL")

    return parser


def cmd_worker_run(args: argparse.Namespace) -> None:
    from opai.core.gopay_protocol_worker import run_worker
    run_worker(
        max_workers=args.workers,
        pin=args.pin,
        poll_interval=args.poll,
        resume_phones=args.resume,
        api_key=args.api_key,
        sms_provider_name=getattr(args, "sms_provider", ""),
    )


def cmd_worker_dry_run(args: argparse.Namespace) -> None:
    from opai.core.gopay_protocol_worker import _register_one, _make_proxy, _get_envelope_did
    from opai.core.sms_provider import create_sms_provider

    provider = create_sms_provider(getattr(args, "sms_provider", ""), args.api_key)
    if not provider.api_key:
        raise SystemExit("No API key. Set --api-key or configure in config.json")
    proxy = _make_proxy()
    envelope_did = _get_envelope_did()
    result = None
    try:
        result = _register_one(provider, args.pin, proxy, envelope_did)
        if isinstance(result, dict):
            print(f"SUCCESS: {result['phone']} pin={args.pin} order_id={result['aid']}")
        else:
            raise SystemExit("FAILED")
    finally:
        provider.release_unused(keep=(result["aid"] if isinstance(result, dict) else None))


def cmd_worker_register(args: argparse.Namespace) -> None:
    import logging as _log
    from opai.core.gopay_protocol_worker import _register_one, _make_proxy, _get_envelope_did
    from opai.core.sms_provider import create_sms_provider

    import time as _time
    provider = create_sms_provider(getattr(args, "sms_provider", ""), args.api_key)
    if not provider.api_key:
        raise SystemExit("No API key. Set --api-key or configure in config.json")
    envelope_did = _get_envelope_did()
    log = _log.getLogger(__name__)
    max_attempts = 20
    success_aid = None
    consecutive_fails = 0
    try:
        for attempt in range(1, max_attempts + 1):
            proxy = args.proxy or _make_proxy()
            log.info("Register attempt %d/%d", attempt, max_attempts)
            result = _register_one(provider, args.pin, proxy, envelope_did)
            if isinstance(result, dict):
                success_aid = result["aid"]
                print(json.dumps({
                    "phone": result["phone"],
                    "pin": args.pin,
                    "local": result["local"],
                    "order_id": result["aid"],
                }, indent=2))
                return
            if result == "NO_STOCK":
                if not provider.escalate_price():
                    _time.sleep(3)
                consecutive_fails = 0
            elif result == "RATE_LIMITED":
                log.info("Rate limited, rotating IP and retrying immediately...")
                consecutive_fails = 0
            else:
                consecutive_fails += 1
                delay = min(5 * consecutive_fails, 30)
                log.info("Waiting %ds before next attempt (fail streak %d)...", delay, consecutive_fails)
                _time.sleep(delay)
        raise SystemExit("FAILED after %d attempts" % max_attempts)
    finally:
        # auto-cancel every rented-but-unused number for refund (keep the success one)
        provider.release_unused(keep=success_aid)


def cmd_worker_balance(args: argparse.Namespace) -> None:
    from opai.core.gopay_protocol_worker import _resume_account, _check_balance

    account = _resume_account(args.phone, proxy=args.proxy)
    if not account:
        raise SystemExit(f"Account {args.phone} not found")
    bal = _check_balance(account["client"])
    print(json.dumps({"phone": account["phone"], "balance_rp": bal}, indent=2))


def cmd_pay(args: argparse.Namespace) -> None:
    from opai.core.gopay_payment_protocol import GoPayPayment

    payment = GoPayPayment(proxy=args.proxy)
    result = payment.pay(
        midtrans_url=args.midtrans_url,
        phone=args.phone,
        country_code="62",
        pin=args.pin,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    if args.command == "worker":
        if args.worker_command == "run":
            cmd_worker_run(args)
        elif args.worker_command == "dry-run":
            cmd_worker_dry_run(args)
        elif args.worker_command == "register":
            cmd_worker_register(args)
        elif args.worker_command == "balance":
            cmd_worker_balance(args)
        else:
            parser.parse_args(["worker", "--help"])
    elif args.command == "pay":
        cmd_pay(args)
    else:
        parser.print_help()
