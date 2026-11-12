# MiMo isolated browser permission (2026-10-29)

## User grant recorded

The parent described the full scope through `ask_user_question`; the user chose
**“允许一次隔离启动”** (allow one isolated launch). The recorded scope is:

- one fresh temporary directory containing a clean `DSH_HOME`, `HOME`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`/`TMP`, and a fresh browser
  `user-data-dir`;
- one local temporary Web SDK child, bound to an ephemeral loopback port
  (the permission's `port 0` intent is implemented by reserving one loopback
  ephemeral port before launch and passing it explicitly; before any HTTP,
  verify the port belongs to that child and explicitly protect the main GUI
  port `14574`);
- one fresh Chrome or Edge process using a public installed executable and a
  fresh browser data directory;
- no reading/copying the real profile, browser login state, cookies, or
  credentials; no access to the main GUI `14574`; no CDP or
  `remote-debugging-port`; no login, QR scan, balance query, or official
  network request;
- no old mount/old six-service permission reuse;
- stop and report if any condition cannot be satisfied; do not retry
  automatically; clean up at the end.

The target is the real published **base + web-app** bundle composition plus the
one frozen R2 file entry, with a real browser bootstrap/settings graph. It is
not a full Desktop native-bridge acceptance and must not use a six-service
explicit composition, a VM shim, or fake slots to stand in for the real graph.

## Execution gate / status

**Old authorized attempt: CONSUMED.** The earlier `impl/run.ps1 -Execute`
created its permit/USED and stopped before SDK start with
`E_PS_HOME_READONLY`; no SDK/browser/port/probe ran, so there is no new MiMo
evidence. The old permit, USED, run, hashes, and result documents are retained
unchanged and must not be deleted or reused.

**Corrected copy: EXECUTED_ONCE_CONSUMED.** The new sibling
`.diagnostics/mimo-browser-isolated-20261029/fix-init/` fixes the `$home`
automatic-variable collision, runs the shared initialization before the
one-shot marker, and moves the create-new permit/USED consumption to
immediately before port/process start. Its controlled
`run.ps1 -PrepareOnly` check reached `after_init_before_marker`, created only
its own empty temp root/profile/hook copy, cleaned it, and returned
`PREPARE_ONLY_OK` with exit `0`.

A fresh human authorization was then used for exactly one `fix-init -Execute`
lifecycle. It reached SDK-ready + browser dump, but the probe observed **no MiMo
client apply** (`applyCalled=false`, `state/uid/epoch=null`,
`inertia_field_present=false`); there is no MiMo startup or error conclusion.
The new `fix-init` permit/USED are retained as consumed, its temp root was
removed, and no retry occurred. See `fix-init/RESULT.md` and
`fix-init/PERMISSION-STATUS.md`.

This scope is consumed. Any further run needs a fresh explicit human
authorization; this document is not an EXECUTE and no new permission is active.


Runtime output is limited to fixed booleans/counts/codes, package names, and
source hashes. Owner URL/token/cookie, raw stdout/HTML/DOM, error text, and
browser state are handled in memory only and never written to logs or Git.
The fresh browser cookie may exist only inside its temporary directory and is
deleted during cleanup without reading its value.

VM/JS instrumentation and command-line flags are not an OS sandbox; external
browser traffic is limited by flags and is not fully observable without CDP,
which is disallowed. The probe is read-only and does not create providers,
slots, services, state machines, or a remote-control channel.
