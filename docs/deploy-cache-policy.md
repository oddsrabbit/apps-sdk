# Deploy: cache policy for apps.oddsrabbit.com

Every asset reference in this bundle is versioned — `?v=<BUILD_ID>` for per-build
files, `?v=<content hash>` for the shared `sdk-v1.js` / `leaderboard-v1.js`. That
scheme only works if the **HTML entry points are always revalidated**. If an
entry point is cached, the client keeps pointing at the old versioned URLs
forever, and replacing the files on disk changes nothing for it.

The entry points are:

| URL | Loaded by |
| --- | --- |
| `/host/?app=<slug>&v=<manifest updatedAt>&colorScheme=<light\|dark>` | the web surface (`inc/js/pages/games.js`) |
| `/host/?app=<slug>&v=<manifest updatedAt>&colorScheme=<light\|dark>` | the mobile app's WebView (`AppHost.tsx`) |
| `/<slug>/?v=<manifest updatedAt>&colorScheme=<light\|dark>` | the host page's inner game iframe |

All three are **directory-index URLs with no filename**. That matters — see below.

All three now carry `&v=<manifest updatedAt>`. Mobile omitted it until `b05e0c68`
(2026-08-05), which is why the incident at the end of this document hit mobile
only. That asymmetry is closed.

> **The `updatedAt` bump is the only cache-bust this origin actually has.**
> No `Cache-Control` is set on the HTML entry points (see the next section), so
> nothing forces a client to revalidate them. `updatedAt` is what changes the
> URL, and it does **not** move on deploy — it is bumped by hand from
> `tools/setup-apps-platform.php` → "Bump cache version". Upload without
> bumping and clients keep serving the copy they already hold; the files on
> disk are new and no one sees them. That is the expected behaviour of a
> correct cache, not a bug to go hunting for.
>
> This has now cost two debugging sessions. Bump after every upload.

## The fix lives in server config — there is no `.htaccess`

`build.config.mjs` used to write a `dist/.htaccess` so a policy would travel with
every upload. **The origin does not read it**, so it never took effect, and the
generation was removed — an inert config file is worse than none, because it
reads as a solved problem while the headers it describes were never set. Don't
re-add it. Don't be misled by `GET /.htaccess` returning 403 either; that is
nginx's own `location ~ /\. { deny all; }` boilerplate, not Apache protecting
the file.

Until the vhost below is applied, the entry points have **no cache policy at
all** and the manual `updatedAt` bump is the only thing invalidating them.

What the live origin actually sends, measured on a cache miss (`?cachetest=…`
forces a fresh key so you see origin headers, not stored ones):

```
GET /host/?cachetest=1        → (no Cache-Control at all)
GET /rabbit-words/?cachetest=1→ (no Cache-Control at all)
GET /host/host.js?cachetest=1 → cache-control: public, max-age=31536000
GET /host/host.css?cachetest=1→ cache-control: public, max-age=31536000
GET /host/index.html?cachetest=1 → cache-control: public, max-age=31536000
GET /host/host.js.map         → (no Cache-Control at all)
```

So an `expires`-style rule covers asset extensions **and `.html`**, while
everything else — including every directory-index entry point — goes out with no
cache directive at all. Both halves are wrong: a one-year `.html` is the exact
freeze this scheme cannot tolerate, and a missing directive lets each cache in
the path invent its own TTL. The latter is what froze
`/host/?app=…&colorScheme=…` for three weeks behind the front cache (`x-cache` +
`age` on responses).

Add this to the `apps.oddsrabbit.com` vhost:

```nginx
# http{} scope — must be outside the server block.
map $uri $apps_cache_control {
    # Entry points, source maps, anything not covered below.
    default                 "no-cache, must-revalidate, max-age=0";
    # Empty value = nginx skips add_header entirely, leaving the existing
    # `expires` rule for versioned assets untouched. Stamping them here as well
    # would emit TWO Cache-Control headers, since add_header appends.
    ~*\.(js|css|woff2|png)$ "";
}

server {
    server_name apps.oddsrabbit.com;
    add_header Cache-Control $apps_cache_control always;
}
```

…and **remove `html` from whatever `expires` rule currently grants it a year**
(usually a `location ~* \.(css|js|html|…)$ { expires 1y; }`). Leave it in place
and `.html` responses carry two `Cache-Control` headers — `add_header` appends,
it does not replace what the `expires` module already wrote. The directory-index
URLs the clients actually request are unaffected either way, but a file serving
two contradictory cache directives is a trap for the next person.

Two nginx behaviours worth knowing before you place that line:

- `add_header` does not inherit into a `location` that has `add_header`
  directives of its own. If the vhost already sets headers per-location, put
  this line in the same contexts rather than only at server scope.
- `$uri` is post-index-resolution, so `/host/?app=…` evaluates as
  `/host/index.html` — it takes the `default` branch, which is what we want.
  (Location matching evidently does *not* re-run for it on this config, since
  `/host/` escapes the `.html` rule that `/host/index.html` hits — which is
  precisely why the fix belongs at server scope rather than in a location.)

Reload with `nginx -t && systemctl reload nginx`, then confirm exactly one
header: `curl -sI "https://apps.oddsrabbit.com/host/?cachetest=$RANDOM" | grep -ci cache-control`
should print `1`.

## The front cache must be purged, not just reconfigured

Responses carry `x-cache: HIT|MISS` and `age`, so something in front is storing
copies — and it keys on the **full URI including the query string**, which is
why every `(app, colorScheme)` pair went stale independently and the breakage
looked app-specific rather than total.

Fixing the header stops new copies being stored; entries already held keep
serving until they expire. **The purge is what unblocks users already on a
shipped app build** — no client update required, since the stale copy was never
on their device. Purge Cloudflare too if you like: it reports `cf-cache-status:
DYNAMIC` for these URLs, so it is not the layer at fault, but it costs nothing.

If `x-cache: HIT` returns with a stale build after the purge, that layer is
storing regardless of origin headers (fixed TTL / "cache everything"). Exclude
the entry points explicitly — most panels take a URL pattern (`/host/*` plus each
game's directory index). In raw nginx, if the layer is nginx's own cache:

```nginx
location ~ ^/([^/]+/)?$ {
    proxy_no_cache 1;
    proxy_cache_bypass 1;   # fastcgi_* equivalents if it is a FastCGI cache
}
```

## Verify after deploying

Every variant must report the current `BUILD_ID` — check the ones the app
actually loads, not just `/host/`, since each is a separate cache entry:

```sh
for a in rabbit-words 2048 snake rabbit-globe solitaire match3 liquid; do
  for s in light dark; do
    printf '%-14s %-5s ' "$a" "$s"
    curl -s "https://apps.oddsrabbit.com/host/?app=$a&colorScheme=$s" \
      | grep -o 'host.js?v=[0-9]*'
  done
done

# And that the entry point is no longer cacheable:
curl -sI "https://apps.oddsrabbit.com/host/?app=rabbit-words&colorScheme=light" \
  | grep -iE 'cache-control|x-cache|age'
```

## Incident this documents (2026-08-05)

`/host/?app=rabbit-words&colorScheme=light` served the **2026-07-16** host
bundle (`host.js?v=1784187666990`) for ~3 weeks after it was replaced, while
`/host/` with no query string served the current one. That build predates the
`scores.season` and `scores.rank` bridge verbs, so its `BridgeRequestSchema`
rejected them (`msg from game: rejected by schema`) — and it also predates the
answer-on-reject fix in `84045dc`, so the requests were dropped with no
response. The SDK promise never settled and every season leaderboard sat on
"Loading…" on mobile. Roughly half the `(app, colorScheme)` variants were
affected.

The web surface was fine throughout, and loads the same page — it just asks for
a different URL:

```
/host/?app=rabbit-words&v=2026-08-03T07:08:41Z&colorScheme=light → host.js?v=1785746253495  (current)
/host/?app=rabbit-words&colorScheme=light                        → host.js?v=1784187666990  (three weeks stale)
```
