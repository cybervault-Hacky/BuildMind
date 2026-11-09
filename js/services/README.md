# Service layer

The boundary between the UI and every future integration. Read top to bottom:

```
contracts.js   result envelope + error model + createService() wrapper
storage.js     the only localStorage access; refuses sensitive key names
ai/            providers.js (single catalog), stages.js (7 stages),
               mockAIService.js (simulated builds, timed stages)
connections/   mockRobloxService.js, mockStudioService.js — deliberately separate
projects/      localProjectService.js (list/get/create/update/delete)
settings/      localSettingsService.js (load/save/reset + prompt draft)
```

## Rules

1. Every public method resolves to `{ ok: true, data }` or
   `{ ok: false, error: { type, message } }`. Never a bare value, never a throw.
2. `error.type` is one of `validation | connection | configuration | operation |
   cancelled | unknown`, with short user-safe copy. No stack traces.
3. Services do not hold UI state. State lives in `js/state.js` and is written by
   the controllers in `js/controllers/`.
4. Services never call each other's storage directly; persistence goes through
   `storage.js`.
5. No network calls. No keys. No provider SDKs.

## Replacing a mock

Implement the same method names with the same envelopes, then swap the script
tag in the four HTML files. Nothing in `js/state.js`, `js/controllers/` or the
page scripts needs to change.

| Replace | With |
| --- | --- |
| `ai/mockAIService.js` | a router plus one adapter per provider |
| `connections/mockRobloxService.js` | an OAuth hand-off behind a backend |
| `connections/mockStudioService.js` | a local Studio bridge probe |
| `projects/localProjectService.js` | a remote project service |
| `settings/localSettingsService.js` | a per-account settings service |
