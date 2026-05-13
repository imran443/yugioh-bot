# Neos Duel Web Runtime

This repo keeps the upstream Neos browser client isolated under `vendor/neos-ts` while the first integration spike proves local runtime viability.

## Setup

Initialize the Neos submodule and its nested protobuf submodule:

```bash
git submodule update --init --recursive vendor/neos-ts
```

Install Neos dependencies inside the vendor checkout:

```bash
npm run setup:duel-web
```

## Checks

Verify that the Neos checkout is present and initialized:

```bash
npm run check:duel-vendor
```

Start the Neos Vite dev server and verify the entrypoint plus config endpoint:

```bash
npm run smoke:duel-web
```

Build the Neos app:

```bash
npm run build:duel-web
```

## Development

Run Neos locally through the wrapper workspace:

```bash
npm run dev:duel-web -- --host 0.0.0.0 --port 5173
```

The first spike does not mount Neos inside `packages/web`. Keep Neos isolated until the bridge/result contract work is planned and tested.

## Feasibility Gates

Continue with Neos only if these checks pass in follow-up spikes:

1. Force English as the embedded default and verify custom-room, wait-room, deck-select, and duel screens show English text.
2. Verify English card names and effects load from usable `en-US` card resources or from an app-owned replacement catalog.
3. Create or join a controlled `1v1` room from app-provided session data instead of relying on manual public-room navigation.
4. Map app users to Neos player seats deterministically.
5. Capture a completed duel winner from Neos' semantic duel layer, then emit an app-owned result payload.
6. Decide whether to self-host a compatible `srvpro`/YGOPro backend or use a controlled external backend.

If English card data, controlled room creation, or result capture cannot be proven, pivot to an `ocgcore`/YGOPro-core service spike instead of deepening the Neos integration.

## Tag Duels

Tag duels are not a v1 capability. Neos has some upstream signs of tag support, but its current frontend is mostly `me`/`op` oriented and does not appear tag-ready. Keep the app-side duel session model team/seat-based now, but treat tag duels as a later major client/backend compatibility project.

## Notes

- `packages/duel-web` intentionally has no `build`, `test`, or `typecheck` script yet, so root Turbo commands are not affected by the Neos spike.
- Neos uses React 18 and Vite; the existing dashboard uses React 19 and Next.js 16. Treat the Neos client as a separate web runtime until a later embedding plan decides otherwise.
- Neos is GPL-3.0. Preserve license notices and keep Neos-derived code easy to audit.
