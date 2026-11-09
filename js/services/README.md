# Service layer

The boundary between the UI and every future integration. Read top to bottom:

```
contracts.js   result envelope + error model + createService() wrapper
storage.js     the only localStorage access; refuses sensitive key names
ai/            providers.js (single catalog), stages.js (7 stages),
               mockAIService.js (simulated builds, timed stages)
connections/   mockRobloxService.js, mockStudioService.js — deliberately separate
projects/      projectModel.js (pure helpers) +
               localProjectService.js (list/get/create/update/recordBuild/
               markRun/delete)
settings/      localSettingsService.js (load/save/reset + prompt draft +
               reset scope)
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
6. `aiService` events follow one schema and always carry a `runId`; consumers
   ignore events from a run that is no longer active.
7. Persisted records are normalised on read, not trusted: anything malformed is
   repaired to a valid shape (id, name, status, timestamps, prompt, art) and a
   record that cannot be repaired is dropped. Corrupt JSON behaves like an
   empty store.

## The project service

`localProjectService` is the only writer of `buildmind.projects.v1`. Its
contract:

| Method | Returns | Notes |
| --- | --- | --- |
| `listProjects()` | `{ projects }` | seeds four clearly-labelled sample projects for a brand-new visitor; an explicit `[]` is respected and never re-seeded |
| `getProject(id)` | `{ project }` | `validation` failure when missing |
| `createProject(data)` | `{ project, created: true }` | starts as `draft`, or `ready` when it already has a prompt |
| `updateProject(id, patch)` | `{ project }` | name, description, prompt, status, art, scene, `updatedAt` |
| `recordBuild({ prompt, runId, projectId })` | `{ project, created, duplicate }` | the **only** method that writes `lastBuildAt` |
| `markRun(id, outcome, runId)` | `{ project }` | records `stopped` / `error`; never touches the last build |
| `deleteProject(id)` | `{ id }` | hard delete, no tombstone |
| `subscribe(listener)` | unsubscribe | emitted after every successful write |

**Lifecycle.** `draft | ready | building | testing | fixing | validating |
complete | stopped | error` — the same nine states the build machine can reach,
plus `draft`. Nothing else is accepted; anything unrecognised normalises to
`draft`. The in-flight subset is exactly `building, testing, fixing,
validating`.

**Record shape.**

```js
{
  id, name, description, prompt,
  status,                  // one of the nine above
  created, updatedAt,      // epoch ms
  lastBuildAt,             // 0 until a build actually completes
  runId,                   // the run that last completed a build
  art, scene,              // CSS preview, derived deterministically
  history: [ { type, at, runId? } ],   // created | complete | stopped | error
  simulated: true
}
```

**Identity.** `recordBuild` is idempotent on `runId`: the same run recorded
twice returns the stored project with `duplicate: true` and changes nothing.
Otherwise an explicit `projectId` wins; failing that, a project with the same
derived name is reused when it has no build or the prompt is unchanged. A
different prompt under a colliding name is a separate project, so one run can
never overwrite another project's finished work.

**Migration.** Records written before this lifecycle used
`{ id, name, status, updated, art, scene, lastBuild: true }`. They are read
once, their relative label (`"2 days ago"`) is parsed into a real timestamp,
`lastBuild: true` becomes a `lastBuildAt`, and they are rewritten in the new
shape on the next write. Nothing newer than the stored `updated` value is
invented.

`projectModel.js` holds the parts that are not storage: relative-time copy, the
last-build line, description derivation from a prompt, status metadata, event
copy, ordering and the name/description search matcher. It has no state and
touches no storage, so both the service and the renderer can use it.

## The settings service

`localSettingsService` is the only writer of `buildmind.settings.v1`,
`buildmind.preferences.v1` and `buildmind.connections.v1`.

| Method | Returns | Notes |
| --- | --- | --- |
| `loadSettings()` | `{ settings, motion, connections, systemMotion }` | normalised on read; `systemMotion` is the OS preference, reported not stored |
| `saveSettings(patch)` | `{ settings, motion, connections, systemMotion }` | accepts `provider`, `model`, `autoFix`, `hints`, plus `motion` and `connections`, each written to its own key |
| `resetSettings()` | `{ settings, motion, connections, systemMotion, reset }` | restores the three configuration keys; `reset` lists the scope it applied |
| `loadPromptDraft()` / `savePromptDraft(text)` | `{ prompt }` | 600-character cap |
| `getPersistedKeys()` | `{ keys, all, sensitive: [] }` | diagnostics; `sensitive` is always empty because no such key exists |
| `_defaults()` | `{ provider, model, autoFix, hints }` | test hook, unwrapped |
| `_resetScope()` | `["provider","model","preferences","motion","connections"]` | the single description of what reset changes |

**Normalisation is the guarantee.** `normalize()` rejects an unknown provider
(→ `openai`), rejects a model that does not belong to the provider (→ that
provider's default) and coerces the booleans. A stored pair that a catalogue
change invalidates therefore loads as a valid pair; nothing downstream has to
defend against it.

**Reset never touches user work.** It rewrites `settings`, `preferences` and
`connections` and nothing else. `buildmind.projects.v1` (every project and its
history) and `buildmind.draft.v1` (the prompt draft) are not settings and are
left exactly as they were. There is no `clearAll` on the public surface.

**No key writer exists.** The service has no method that accepts an API key, so
there is no path — accidental or otherwise — from the key field to storage. The
key's presence for a session is a boolean in `js/state.js` that starts false on
every load.

**Connections are stored as booleans, not statuses.** `{ roblox: boolean,
studio: boolean }` can only express "connected" or "not connected"; the
transient `connecting` status lives in state and is never persisted, so a reload
cannot land on a stuck transition.

## Replacing a mock

Implement the same method names with the same envelopes, then swap the script
tag in the four HTML files. Nothing in `js/state.js`, `js/controllers/` or the
page scripts needs to change.

| Replace | With |
| --- | --- |
| `ai/mockAIService.js` | a router plus one adapter per provider |
| `connections/mockRobloxService.js` | an OAuth hand-off behind a backend |
| `connections/mockStudioService.js` | a local Studio bridge probe |
| `projects/localProjectService.js` | a remote project service (same eight methods, same envelopes) |
| `settings/localSettingsService.js` | a per-account settings service |
