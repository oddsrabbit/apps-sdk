# OddsRabbit Apps SDK

The SDK for building games and apps on [OddsRabbit](https://www.oddsrabbit.com).

> 🚧 **Alpha.** APIs subject to change.

- **Full developer guide:** [oddsrabbit.com/developers/games](https://www.oddsrabbit.com/developers/games/)
- **Reference games:** [`rabbit-words/`](./rabbit-words/), [`2048/`](./2048/), [`snake/`](./snake/), [`liquid/`](./liquid/)

## Hello world

```html
<!doctype html>
<script src="https://apps.oddsrabbit.com/sdk-v1.js"></script>
<h1>Hello!</h1>
<script>
  OddsRabbit.whenReady().then(() => {
    document.querySelector('h1').textContent = OddsRabbit.user
      ? `Hi ${OddsRabbit.user.username}!`
      : 'Welcome, guest!';
    OddsRabbit.ready(); // hides the host's loading skeleton
  });
</script>
```

## Install

**CDN** (vanilla HTML — recommended):

```html
<script src="https://apps.oddsrabbit.com/sdk-v1.js"></script>
```

**npm** (TypeScript / build-tool apps):

```bash
npm install @oddsrabbit/apps-sdk
```

```ts
import { OddsRabbit } from '@oddsrabbit/apps-sdk';
```

## What you get

Everything available on `window.OddsRabbit` once `await OR.whenReady()` resolves:

- **`OR.user`** — the signed-in user's `{ uuid, username }`, or `null` for guests.
- **`OR.sessionToken`** — short-lived JWT for verifying the user on your backend.
- **`OR.colorScheme`** — the host's `'light'` or `'dark'` theme.
- **`OR.storage.get/set/delete`** — per-user key/value store. Syncs across the user's mobile and web sessions; falls back to local browser storage for guests.
- **`OR.aggregate.count`** — community-wide counts ("X% of players picked Y"). Returns `null` below a k=5 anonymity floor.
- **`OR.actions.share`** — system share sheet on mobile, Web Share API on web.
- **`OR.actions.haptic`** — `'light' | 'medium' | 'success' | 'error'`. No-op on web.
- **`OR.actions.requestSignIn`** — prompt the user to sign in at a natural friction moment.
- **`OR.lifecycle.on`** — `'pause' | 'resume' | 'terminating'` hooks for animations and state-flushing.

Full method signatures, manifest schema, scopes, and error codes live in the [developer guide](https://www.oddsrabbit.com/developer-games/).

## Verifying users on your backend

If your app has its own server, verify `OR.sessionToken` rather than trusting client-supplied UUIDs:

```ts
// In your app:
fetch('/my-backend/play', {
  headers: { Authorization: `Bearer ${OddsRabbit.sessionToken}` },
});
```

On your backend, verify the JWT against our JWKS:

```
https://apps.oddsrabbit.com/.well-known/jwks.json
```

Standard RS256 verification — confirm `iss === 'https://oddsrabbit.com'`, `aud === your_app_uuid` (assigned at registration; not your manifest `id` slug), and `exp` is in the future. The `sub` claim is the OddsRabbit user UUID.

## What's in this repo

```
src/sdk/        The SDK loaded inside app iframes
src/host/       Sandbox host page that loads dev appUrls
src/schemas/    Zod schemas — single source of truth for the bridge
rabbit-words/   RabbitWords — reference game (Games surface, Phase 1)
2048/           2048 port — reference game
snake/          Snake — Game Boy-styled reference game
liquid/         Liquid WebGL toy — reference app, no scopes
```

## Contributing

**Issues welcome** — bugs, questions, feature requests.

**PRs by invitation.** The bridge has security boundaries we'd like to keep tight, so please file an issue first; if it's a fit we'll invite a PR. (Same model Stripe and several similar SDKs use — public source for trust and debuggability, controlled contribution for review capacity.)

## License

MIT — see [`LICENSE`](./LICENSE).
