#!/usr/bin/env python3
"""Manage the current shadok-ai channel's scheduled prompts (crons) via the
local server API. Reads SHADOK_SESSION_ID / SHADOK_PORT / SHADOK_AUTH from the
env (injected by shadok-ai into every agent)."""
import argparse, json, os, sys, urllib.error, urllib.parse, urllib.request

PORT = os.environ.get("SHADOK_PORT")
SID = os.environ.get("SHADOK_SESSION_ID")
AUTH = os.environ.get("SHADOK_AUTH", "")
if not PORT or not SID:
    sys.exit("Not inside a shadok-ai channel (SHADOK_PORT / SHADOK_SESSION_ID unset).")
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
        sys.exit(f"API error {e.code}: {e.read().decode()[:200]}")


def parse_schedule(spec):
    spec = spec.strip().lower()
    if spec.startswith("every:"):
        v = spec[6:]
        if v.endswith("h"):
            return {"kind": "interval", "everyMin": int(v[:-1]) * 60}
        if v.endswith("m"):
            return {"kind": "interval", "everyMin": int(v[:-1])}
        return {"kind": "interval", "everyMin": int(v)}
    if spec.startswith("daily:"):
        h, m = spec[6:].split(":")
        return {"kind": "daily", "hour": int(h), "minute": int(m)}
    raise SystemExit(f"bad schedule '{spec}' (use every:30m, every:2h, or daily:09:00)")


def label(s, tz=None):
    if s["kind"] == "interval":
        return f"every {s['everyMin']}m"
    # Le fuseau est toujours montré : « daily 09:00 » nu ne dit pas 9h OÙ, et
    # c'est précisément ce qui fait croire qu'un serveur en UTC est à l'heure.
    return f"daily {s['hour']:02d}:{s['minute']:02d}" + (f" ({tz})" if tz else "")


def main():
    p = argparse.ArgumentParser(prog="schedule")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--schedule", required=True)
    a.add_argument("--prompt", required=True)
    a.add_argument("--check", default=None, help="guard command; silent = nothing to report (0 tokens)")
    a.add_argument("--tz", default=None, help="IANA timezone for a daily schedule (e.g. Europe/Paris); default = server setting")
    t = sub.add_parser("tz", help="show or set the default timezone of daily schedules")
    t.add_argument("zone", nargs="?", help="IANA name (e.g. Europe/Paris); omit to show, '-' to clear")
    sub.add_parser("env", help="show the cwd and the secret names a --check guard will get")
    sub.add_parser("list")
    d = sub.add_parser("del")
    d.add_argument("id")
    args = p.parse_args()

    if args.cmd == "add":
        body = {"sessionId": SID, "prompt": args.prompt, "schedule": parse_schedule(args.schedule), "enabled": True}
        if args.check:
            body["check"] = args.check
        if args.tz:
            body["tz"] = args.tz
        r = api("POST", "/crons", body)
        print(f"scheduled [{r['id'][:8]}] {label(r['schedule'], r.get('timezone'))}" + (" +guard (0 tokens on quiet runs)" if args.check else ""))
    elif args.cmd == "list":
        mine = [c for c in api("GET", "/crons") if c.get("sessionId") == SID]
        if not mine:
            print("(no schedule on this channel)")
            return
        tzinfo = api("GET", "/timezone")
        for c in mine:
            flags = ("" if c["enabled"] else " (paused)") + (" +guard" if c.get("check") else "")
            tz = c.get("tz") or tzinfo.get("timezone") or tzinfo.get("system")
            print(f"[{c['id'][:8]}] {label(c['schedule'], tz)}{flags}\n   {c['prompt'][:100]}")
    elif args.cmd == "tz":
        if args.zone:
            r = api("POST", "/timezone", {"timezone": "" if args.zone == "-" else args.zone})
        else:
            r = api("GET", "/timezone")
        cur = r.get("timezone")
        print(f"daily schedules run in: {cur or r.get('system')}" + ("" if cur else " (machine default — set one to pin it)"))
    elif args.cmd == "env":
        # A guard runs server-side, not in this agent's process: it gets the
        # secrets of the CHANNEL's profile, never whatever happens to sit in
        # this shell. Agents that can't see that list assume the worst and
        # hardcode the value into the check script — printing it is the fix.
        ch = next((c for c in api("GET", "/channels") if c.get("sessionId") == SID), None)
        if not ch:
            print("this channel is not registered server-side: a guard would run from the")
            print("server's own directory, with no profile secrets at all.")
            return
        print(f"guard cwd: {ch.get('cwd') or '(server default)'}")
        pname = ch.get("profile")
        if not pname:
            print("guard secrets: NONE — this channel has no profile.")
            print("  Secrets reach a guard only through the channel's profile; attach one")
            print("  (web UI, the agent's profile picker) that lists the names you need.")
            return
        prof = next((p for p in api("GET", "/profiles") if p.get("name") == pname), None)
        if prof is None:
            # Same end result as "no secrets", but a very different cause: say
            # which one, or the report reads as a working setup.
            print(f"guard secrets: NONE — the channel points at profile '{pname}', which no longer exists.")
            return
        wanted = prof.get("secrets") or []
        if not wanted:
            print(f"guard secrets: NONE — profile '{pname}' lists no secret.")
            return
        vault = set(api("GET", "/secrets").get("names") or [])
        present = [n for n in wanted if n in vault]
        missing = [n for n in wanted if n not in vault]
        print(f"guard secrets (profile '{pname}'): {', '.join(present) if present else 'NONE'}")
        if missing:
            # `secretsFor` skips an unknown name without a word, so a typo here
            # looks exactly like a working guard until the day it runs.
            print(f"  referenced but NOT in the vault, so absent at run time: {', '.join(missing)}")
    elif args.cmd == "del":
        # `list` n'affiche que 8 caractères de l'id : le serveur accepte ce
        # préfixe. On imprime CE QU'IL a supprimé — l'ancienne version
        # annonçait « deleted » sans jamais rien supprimer.
        r = api("DELETE", f"/crons?id={urllib.parse.quote(args.id)}")
        print(f"deleted {r.get('id', args.id)[:8]}")


if __name__ == "__main__":
    main()
