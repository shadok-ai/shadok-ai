#!/usr/bin/env python3
"""Put a secret the agent OBTAINED into shadok-ai's vault, through the local API.

The value is read from STDIN, never from argv: `ps` exposes a process's
arguments to every user on the machine, so a token passed as a parameter leaks.
There is deliberately no way to read a value back out.

Reads SHADOK_PORT / SHADOK_AUTH from the env (injected into every agent).
"""
import argparse, json, os, sys, urllib.error, urllib.request

PORT = os.environ.get("SHADOK_PORT")
AUTH = os.environ.get("SHADOK_AUTH", "")
if not PORT:
    sys.exit("Not inside a shadok-ai agent (SHADOK_PORT unset).")
BASE = f"http://127.0.0.1:{PORT}"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    if AUTH:
        req.add_header("Cookie", AUTH)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 409:
            sys.exit(
                "refused: a secret by that name already exists. Do NOT overwrite it "
                "yourself — tell the user and let them decide."
            )
        sys.exit(f"API error {e.code}: {e.read().decode()[:200]}")
    except urllib.error.URLError as e:
        sys.exit(f"cannot reach the cockpit on {BASE}: {e.reason}")


def main():
    ap = argparse.ArgumentParser(description="shadok-ai secret vault (write-only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="print the secret NAMES (never values)")
    s = sub.add_parser("set", help="store a value read from stdin")
    s.add_argument("name")
    # Required, not optional: it removes any way to pass a value in argv.
    s.add_argument(
        "--stdin",
        action="store_true",
        required=True,
        help="read the value from stdin (the only way)",
    )
    args = ap.parse_args()

    if args.cmd == "list":
        names = api("GET", "/secrets").get("names", [])
        print("\n".join(names) if names else "(vault empty)")
        return

    value = sys.stdin.read().strip()
    if not value:
        sys.exit("nothing on stdin — pipe the value in, e.g. `gh auth token | ... --stdin`")
    api("PUT", "/secrets", {"name": args.name, "value": value})
    print(f"stored {args.name} in the vault")
    print("It reaches an agent only once attached to a profile (web Profiles panel).")


main()
