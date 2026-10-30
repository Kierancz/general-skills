#!/usr/bin/env python3
"""Build a one-page bill-splitting calculator from an itemized bill.

  billsplit.py BILL.json --person NAME[=VENMO] [--person ...] [--payer NAME]
               [--tip PERCENT] --out DIR

BILL.json is the bill as read off the receipt:

  {
    "merchant": "Tacos El Gordo",          # required
    "date": "2026-10-28",                  # optional, ISO date
    "currency": "USD",                     # optional, default USD
    "items": [                             # required, at least one
      {"name": "Carne asada taco", "qty": 3, "price": 10.50}
    ],
    "tax": 3.12,                           # optional
    "fees": [                              # optional; discounts are negative
      {"label": "Service fee", "amount": 4.00, "split": "even"}
    ],
    "tip": 0,                              # optional, a tip already on the bill
    "total": 45.67                         # optional, the printed total, to check against
  }

An item's `price` is the line total, so "3 x Taco 10.50" is qty 3, price
10.50. A line with a whole-number quantity from 2 to 20 becomes that many
separate items, each draggable on its own, with the cents shared out so the
line still adds up. A fee splits `even` (the same for everyone) or `share`
(in proportion to what each person ordered, the default).

Each --person is a name, optionally with a Venmo username after `=`. The
payer (default: the first person) is the one the others pay back.

Writes DIR/index.html from template.html and prints one JSON object. The
receipt image is never copied: the page carries only the items and amounts.
Standard library only.
"""

import argparse
import html
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

TEMPLATE = Path(__file__).with_name("template.html")
VENMO = re.compile(r"^[A-Za-z0-9_-]{5,30}$")
MAX_UNITS = 20


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def cents(value, where):
    """A money amount as whole cents, refusing anything that is not a plain number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(f"{where} must be a number, not {json.dumps(value)}")
    return round(value * 100)


def text(value, where, limit=80):
    if not isinstance(value, str) or not value.strip():
        fail(f"{where} must be a non-empty string")
    return " ".join(value.split())[:limit]


def read_items(raw):
    """The bill's lines as single draggable items, a multi-unit line split into its units."""
    if not isinstance(raw, list) or not raw:
        fail("items must be a non-empty list")
    items = []
    for n, line in enumerate(raw, 1):
        if not isinstance(line, dict):
            fail(f"item {n} must be an object")
        name = text(line.get("name"), f"item {n} name")
        total = cents(line.get("price"), f"item {n} price")
        qty = line.get("qty", 1)
        if isinstance(qty, bool) or not isinstance(qty, (int, float)) or qty <= 0:
            fail(f"item {n} qty must be a positive number")
        if float(qty).is_integer() and 2 <= qty <= MAX_UNITS and total > 0:
            units = int(qty)
            base, extra = divmod(total, units)
            for u in range(units):
                items.append({"name": name, "cents": base + (1 if u < extra else 0), "unit": f"{u + 1} of {units}"})
        else:
            label = f"× {qty:g}" if qty != 1 else ""
            items.append({"name": name, "cents": total, "unit": label})
    return items


def read_fees(raw):
    if raw is None:
        return []
    if not isinstance(raw, list):
        fail("fees must be a list")
    fees = []
    for n, fee in enumerate(raw, 1):
        if not isinstance(fee, dict):
            fail(f"fee {n} must be an object")
        split = fee.get("split", "share")
        if split not in ("even", "share"):
            fail(f"fee {n} split must be 'even' or 'share'")
        amount = cents(fee.get("amount"), f"fee {n} amount")
        if amount:
            fees.append({"label": text(fee.get("label"), f"fee {n} label", 40), "cents": amount, "split": split})
    return fees


def read_people(people, payer):
    out, seen = [], set()
    for entry in people:
        name, _, handle = entry.partition("=")
        name = " ".join(name.split())[:24]
        handle = handle.strip().lstrip("@")
        if not name:
            fail(f"--person {entry!r} has no name")
        if name.lower() in seen:
            fail(f"two people are called {name}; give one a last initial")
        if handle and not VENMO.match(handle):
            fail(f"{handle!r} is not a Venmo username (5-30 letters, digits, - or _)")
        seen.add(name.lower())
        out.append({"name": name, "venmo": handle})
    if not out:
        fail("name at least one --person")
    index = 0
    if payer:
        names = [p["name"].lower() for p in out]
        if payer.strip().lower() not in names:
            fail(f"--payer {payer!r} is not one of the --person names")
        index = names.index(payer.strip().lower())
    return out, index


def render(bill):
    """Fill template.html in one pass, so no inserted text is ever read as a placeholder.

    The data block is JSON with `<`, `>` and `&` as unicode escapes, so nothing
    in it can close the script element or open a comment.
    """
    data = json.dumps(bill).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    title = f"Split: {bill['merchant']}"
    fills = {
        "__TITLE__": html.escape(title, quote=True),
        "__DESCRIPTION__": html.escape("Drag each item to who had it, add the tip, and settle up on Venmo.", quote=True),
        "__MERCHANT__": html.escape(bill["merchant"]),
        "__DATA__": data,
    }
    tokens = re.compile("|".join(map(re.escape, fills)))
    return tokens.sub(lambda m: fills[m.group(0)], TEMPLATE.read_text())


def build(bill_path, people, payer, tip, out):
    try:
        raw = json.loads(Path(bill_path).expanduser().read_text())
    except OSError as err:
        fail(f"cannot read {bill_path}: {err.strerror}")
    except ValueError as err:
        fail(f"{bill_path} is not valid JSON: {err}")
    if not isinstance(raw, dict):
        fail("the bill must be a JSON object")

    merchant = text(raw.get("merchant"), "merchant", 60)
    when = raw.get("date")
    if when is not None:
        try:
            when = date.fromisoformat(when).isoformat()
        except (TypeError, ValueError):
            fail("date must be an ISO date like 2026-10-28")
    currency = raw.get("currency", "USD")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        fail("currency must be a three-letter code like USD")
    items = read_items(raw.get("items"))
    tax = cents(raw.get("tax", 0), "tax")
    fees = read_fees(raw.get("fees"))
    printed_tip = cents(raw.get("tip", 0), "tip")
    people, payer_index = read_people(people, payer)
    if tip is not None and not 0 <= tip <= 100:
        fail("--tip is a percentage from 0 to 100")

    subtotal = sum(i["cents"] for i in items)
    computed = subtotal + tax + sum(f["cents"] for f in fees) + printed_tip
    printed = cents(raw["total"], "total") if raw.get("total") is not None else None
    # A tip already on the bill is the tip; otherwise the page offers one, 20% unless told.
    tip_state = {"mode": "amount", "value": printed_tip} if printed_tip else {"mode": "percent", "value": 20 if tip is None else tip}

    bill = {
        "merchant": merchant,
        "date": when,
        "currency": currency,
        "items": items,
        "tax": tax,
        "fees": fees,
        "tip": tip_state,
        "tipOnBill": bool(printed_tip),
        "people": people,
        "payer": payer_index,
        "madeAt": int(time.time() * 1000),
    }
    out = Path(out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(render(bill))
    report = {
        "ok": True,
        "dir": str(out),
        "merchant": merchant,
        "items": len(items),
        "lines": len(raw["items"]),
        "subtotal": subtotal / 100,
        "tax": tax / 100,
        "fees": [{"label": f["label"], "amount": f["cents"] / 100, "split": f["split"]} for f in fees],
        "tipOnBill": printed_tip / 100,
        "computedTotal": computed / 100,
        "people": [p["name"] + (f" (@{p['venmo']})" if p["venmo"] else "") for p in people],
        "payer": people[payer_index]["name"],
        "venmo": currency == "USD",
    }
    if printed is not None:
        report["printedTotal"] = printed / 100
        report["totalsMatch"] = abs(printed - computed) <= 1
    print(json.dumps(report, indent=2))


def main(argv):
    parser = argparse.ArgumentParser(prog="billsplit.py", description="Build a bill-splitting page from an itemized bill.")
    parser.add_argument("bill", help="the itemized bill as JSON (see the top of this file)")
    parser.add_argument("--person", action="append", default=[], metavar="NAME[=VENMO]",
                        help="someone splitting the bill, optionally with their Venmo username; repeatable")
    parser.add_argument("--payer", help="who paid the bill and is paid back (default: the first --person)")
    parser.add_argument("--tip", type=float, help="the starting tip percentage when the bill has none (default 20)")
    parser.add_argument("--out", required=True, help="folder to write index.html into")
    a = parser.parse_args(argv)
    build(a.bill, a.person, a.payer, a.tip, a.out)


if __name__ == "__main__":
    main(sys.argv[1:])
