# MiMo client-chain probe — execution boundary (2026-10-29)

Only `.diagnostics/mimo-client-chain-20261029/impl/` was added. This probe does
not change R2, the frozen client/stage, the real profile/config/backups,
old permissions, DSH source, or GUI. It starts no service, browser, network
request, or real CLI.

## One baseline

```powershell
node .diagnostics/mimo-client-chain-20261029/impl/baseline.mjs
```

Actual fixed sources: frontend `index-BXV-oxvX.js`, its `vendor-DcuzkuQH.js`,
`dsh-client-modules/lib/client.js`, and the frozen R2 `client.js` (hashes in
`impl/RESULT.md`). The probe imports the actual compiled `jZ/IZ/OZ/st/Ub/jI/Gb`
after removing only the modulepreload IIFE and auto-start block; it uses actual
`ClientModuleSystem`, `ClientEntries`, `Loader`, and `SlotCore`, with a minimal
synthetic boot graph/carrier.

The provider's settings-tab slot requires a settings UI declaration in the real
graph. This baseline supplies the minimal `root`/`settings.section`/
`settings.plugins.tab` declarations through the actual `SlotCore`; that is a
carrier shim, not a claim of full browser/UI graph coverage. No React render or
DOM behavior is involved.

## Result boundary

Baseline result: provider fiber **active (state 2)**, no boot error, network
counters all zero, cleanup disposed, exit **0**. The historical
`dsh-mimo-login-poc: loading` was **not reproduced**; no repeat or single-factor
control was run because there was no natural reproduction.

The remaining gap is the actual settings/UI graph or a real browser bootstrap,
not a replacement mock of Cordis/slots. VM is not an OS sandbox.

## Next-real-slots increment (2026-10-29)

`next-real-slots/case.mjs` removes the two synthetic declarations and loads the
actual `settings-general`, `settings-plugins`, and `settings-shell` client
modules. Result: no historical `loading` reproduction; actual owner services
are absent. `settings-general` requires
`slots/locale/connection/remote/remote.settings/configForms` plus the sidebar/
root slot graph; `settings-plugins` requires `slots/locale` and the
`settings.section` owner; `settings-shell` additionally shows missing
`locale/configForms`. MiMo ends `state=3` because the real settings section is
not declared, and the settings modules report fixed `E_IMPORT` in this carrier.
No fake provider was added. The case exits 0 with cleanup/network counts clean;
the finding is a concrete owner-graph gap, not a fix or a reproduced failure.

A valid next step needs the real remote/settings transport, configForms, locale,
sidebar/root slot graph and settings UI graph, or a harness that initializes
those actual components without fake providers.

