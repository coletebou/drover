#!/usr/bin/env python3
"""App Store Connect API helper for CI signing (stdlib + the openssl CLI only).

  asc-signing.py profiles --type MAC_APP_DIRECT|IOS_APP_STORE --cert-pem FILE --out DIR BUNDLE_ID...
      Find (or register) each bundle ID, delete any profile named drover-ci-<bundle id>, create a fresh
      profile of --type bound to the certificate in --cert-pem, write DIR/<bundle id>.<ext> and install it
      under ~/Library/MobileDevice/Provisioning Profiles. Profile name == "drover-ci-<bundle id>", which is
      what ci-sign.sh passes as PROVISIONING_PROFILE_SPECIFIER.
  asc-signing.py new-cert --type DEVELOPER_ID_APPLICATION|DISTRIBUTION --out DIR
      One-time, run by the owner: make a key + CSR, ask the API to issue the certificate, write DIR/cert.p12
      (random password printed once). Apple may refuse Developer ID creation to non-Account-Holder keys.

Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (.p8). Secret values are never printed.
"""
import argparse, base64, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request, secrets

API = "https://api.appstoreconnect.apple.com/v1"


def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def der_to_raw(sig):  # ECDSA DER -> r||s (32 bytes each)
    assert sig[0] == 0x30
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert sig[i] == 0x02
        n = sig[i + 1]
        out += sig[i + 2:i + 2 + n].lstrip(b"\x00").rjust(32, b"\x00")
        i += 2 + n
    return out


def token():
    kid, iss, key = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_PATH"]
    head = b64u(json.dumps({"alg": "ES256", "kid": kid, "typ": "JWT"}).encode())
    body = b64u(json.dumps({"iss": iss, "iat": int(time.time()), "exp": int(time.time()) + 900,
                            "aud": "appstoreconnect-v1"}).encode())
    msg = f"{head}.{body}".encode()
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=msg, capture_output=True, check=True).stdout
    return f"{head}.{body}.{b64u(der_to_raw(der))}"


def call(method, path, body=None):
    req = urllib.request.Request(API + path if path.startswith("/") else path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        sys.exit(f"ASC API {method} {path.split('?')[0]} -> {e.code}: {detail}")


def pages(path):
    url = path
    while url:
        r = call("GET", url)
        yield from r.get("data", [])
        url = r.get("links", {}).get("next")


def pem_to_der_b64(pem_path):
    lines = [l.strip() for l in open(pem_path) if l.strip() and not l.startswith("-----")]
    return "".join(lines)


def platform_for(bid):
    return "MAC_OS" if ".macos" in bid or bid.endswith(".menubar") else "IOS"


def cmd_profiles(a):
    want = pem_to_der_b64(a.cert_pem)
    certs = [c for c in pages("/certificates?limit=200") if c["attributes"].get("certificateContent") == want]
    if not certs:
        sys.exit("the signing certificate in the keychain is not a certificate of this team (ASC list has no match)")
    cert_id = certs[0]["id"]
    ext = "provisionprofile" if a.type.startswith("MAC") else "mobileprovision"
    inst = os.path.expanduser("~/Library/MobileDevice/Provisioning Profiles")
    os.makedirs(inst, exist_ok=True); os.makedirs(a.out, exist_ok=True)
    existing = {}
    for b in pages("/bundleIds?limit=200"):
        existing[b["attributes"]["identifier"]] = b["id"]
    for bid in a.bundle_ids:
        if bid not in existing:
            r = call("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {
                "identifier": bid, "name": "Drover " + bid.replace(".", " "), "platform": platform_for(bid)}}})
            existing[bid] = r["data"]["id"]
            print(f"registered bundle id {bid} (in the portal, enable App Groups for it and assign group.dev.drover, then re-run)", file=sys.stderr)
        name = "drover-ci-" + bid
        for p in pages(f"/profiles?filter[name]={name}&limit=50"):
            if p["attributes"]["name"] == name:
                call("DELETE", f"/profiles/{p['id']}")
        r = call("POST", "/profiles", {"data": {"type": "profiles",
            "attributes": {"name": name, "profileType": a.type},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": existing[bid]}},
                "certificates": {"data": [{"type": "certificates", "id": cert_id}]}}}})
        at = r["data"]["attributes"]
        blob = base64.b64decode(at["profileContent"])
        for d, fn in ((a.out, f"{bid}.{ext}"), (inst, f"{at['uuid']}.{ext}")):
            with open(os.path.join(d, fn), "wb") as f: f.write(blob)
        print(f"profile {name} ({a.type}) uuid={at['uuid']}")


def cmd_new_cert(a):
    os.makedirs(a.out, exist_ok=True)
    key, csr = os.path.join(a.out, "key.pem"), os.path.join(a.out, "req.csr")
    subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr,
                    "-subj", "/CN=Drover CI signing/O=Drover"], check=True, capture_output=True)
    r = call("POST", "/certificates", {"data": {"type": "certificates", "attributes": {
        "certificateType": a.type, "csrContent": open(csr).read()}}})
    cer = os.path.join(a.out, "cert.cer")
    with open(cer, "wb") as f: f.write(base64.b64decode(r["data"]["attributes"]["certificateContent"]))
    pem = os.path.join(a.out, "cert.pem")
    subprocess.run(["openssl", "x509", "-inform", "der", "-in", cer, "-out", pem], check=True)
    pw = secrets.token_urlsafe(18)
    p12 = os.path.join(a.out, "cert.p12")
    # SHA1/3DES, not OpenSSL 3's AES-256 + SHA-256 MAC default: macOS `security import` rejects that format with
    # "MAC verification failed during PKCS12 import (wrong password?)" even when the password is right.
    subprocess.run(["openssl", "pkcs12", "-export", "-inkey", key, "-in", pem, "-out", p12, "-passout", "env:P12PW",
                    "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "sha1"],
                   check=True, env={**os.environ, "P12PW": pw})
    print(f"wrote {p12}; password: {pw}\nbase64 -i {p12} | pbcopy   # -> secret, password -> its _PASSWORD secret")


ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
p = sub.add_parser("profiles"); p.add_argument("--type", required=True, choices=["MAC_APP_DIRECT", "IOS_APP_STORE"])
p.add_argument("--cert-pem", required=True); p.add_argument("--out", required=True); p.add_argument("bundle_ids", nargs="+")
p.set_defaults(fn=cmd_profiles)
n = sub.add_parser("new-cert"); n.add_argument("--type", required=True, choices=["DEVELOPER_ID_APPLICATION", "DISTRIBUTION"])
n.add_argument("--out", required=True); n.set_defaults(fn=cmd_new_cert)
a = ap.parse_args()
for v in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH"):
    if not os.environ.get(v): sys.exit(f"{v} is not set")
a.fn(a)
