# UI language and copy

Mishh Mashh is English only. Devin’s owner decision on 2026-10-10 replaces the
2026-09-23 English and Spanish rule. Do not add a locale without an owner decision.

The i18n infrastructure stays in place so UI copy has typed keys and a single
source of truth. English (`en`) is the only registered locale. A retired stored
preference or unsupported browser language falls back to English.

## Add or change UI copy

1. Add new keys to the typed `Dict` in `apps/web/src/i18n/types.ts`.
2. Define each key in `apps/web/src/i18n/locales/en.ts`.
3. Render UI copy through `useT()` or `useI18n().t`; preserve interpolation names
   such as `{count}` and `{agent}`.
4. Update the affected English assertions and run the tests by path.

Keep brand names, code, URLs, and technical identifiers unchanged. Built-in
resource content uses its English source fields. Language pickers stay hidden
while the registry contains one locale.

## Validate locally

```sh
pnpm guard
pnpm typecheck
pnpm i18n:check
pnpm --filter @open-design/web test -- tests/i18n
```

`pnpm i18n:coverage` reports dictionary coverage. The locale registry, English
dictionary, README language marker, and tests must agree on `en` as the only
shipped locale. Historical files under `docs/plans/` retain their original policy.
