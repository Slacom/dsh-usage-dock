#!/usr/bin/env python3
# http-fetch.py — local patch for dsh-plan-usage on Windows.
#
# Why: the DSH ACL sandbox spawns commands under a WRITE_RESTRICTED token, and
# schannel (the TLS backend of every curl.exe on this machine) cannot acquire
# credentials under that token (SEC_E_NO_CREDENTIALS). Python's OpenSSL stack
# works fine there, so this shim replaces curl for the plan-usage fetches.
#
# Contract: reads a JSON spec from the PLAN_USAGE_SPEC env var, performs the
# HTTPS request, then prints the response body followed by a
# `__DSH_HTTP__<status>` marker — the same wire format curlJson in util.js
# already parses. urllib's default opener honors Windows system proxy
# settings (Clash system-proxy mode) and env proxies; direct when none set.
#
# Exit codes: 0 on any HTTP response (status may be non-2xx; the body carries
# the error), 127 on connection-level failures (mirrors curl's non-zero exit
# so util.js reports "upstream request failed").

import json
import os
import sys
import urllib.error
import urllib.request

spec = json.loads(os.environ.get('PLAN_USAGE_SPEC') or '{}')
url = spec.get('url') or ''
method = (spec.get('method') or 'GET').upper()
headers = dict(spec.get('headers') or {})
headers.setdefault('User-Agent', 'curl/8.0')  # opencode.ai 403s generic bot UAs
body = spec.get('body')
timeout = spec.get('timeout', 10)

data = body.encode('utf-8') if isinstance(body, str) else body
req = urllib.request.Request(url, data=data, method=method, headers=headers)
try:
    resp = urllib.request.urlopen(req, timeout=timeout)
    payload = resp.read()
    status = resp.status
except urllib.error.HTTPError as e:
    payload = e.read()
    status = e.code
except Exception:
    # Connection-level failure (DNS/TLS/refused): non-zero exit like curl.
    sys.exit(127)

sys.stdout.write(payload.decode('utf-8', 'replace'))
sys.stdout.write('\n__DSH_HTTP__%d' % status)
