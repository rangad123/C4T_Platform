# Deploy — Vercel (web) + Render (API)

The web app is on **Vercel**. The API is on **Render**. They talk to each other
cross-origin. Cookies work because the API sets `SameSite=None; Secure`.

The companion file [render.yaml](../render.yaml) describes the Render side
only. The Vercel side is configured through the Vercel dashboard.

## Quick summary

```
┌─────────────┐   cross-origin    ┌─────────────┐
│   Vercel    │  HTTPS + cookies  │   Render    │
│  (web)      │ ─────────────────▶ │  (API)      │
│             │  NEXT_PUBLIC_API_  │             │
│  Next.js 16 │  BASE → Render URL │  Express 5  │
│  /login     │   same-origin      │  /v1/*      │
│  /app/*     │   for the user     │  Postgres   │
│  /api/v1/*  │                    │  + S3       │
└─────────────┘                    └─────────────┘
```

## 1. Pre-flight (one-time)

You need:

| Service | Cost | Purpose |
|---|---|---|
| Neon PostgreSQL | Free tier | Database |
| Cloudflare R2 (or any S3-compatible) | Free 10 GB/month | File uploads |
| Render | Free tier | Hosts the API |
| Vercel | Free tier (Hobby) | Hosts the web |

### 1.1 Neon database

The schema is wired for Neon's pooled + direct split (`api/prisma/schema.prisma:30-48`).

1. Sign up at <https://neon.tech>, create a project in **Oregon** (same region as Render).
2. Create a database named `crowd4test`.
3. From **Connection Details**, copy two strings:
   - **Pooled connection** → `DATABASE_URL`
   - **Direct connection** (host without `-pooler`) → `DIRECT_DATABASE_URL`
4. Both URLs must end with `?sslmode=require`. Optionally append `&connect_timeout=15` to absorb cold-start latency.

### 1.2 S3-compatible bucket

The API refuses to boot with `STORAGE_DRIVER=local` in production. Cloudflare R2's free tier (10 GB/month) is the cheapest option.

1. Create an R2 bucket.
2. Create an **R2 API token** with `Object Read & Write` scoped to the bucket.
3. Note down:
   - `S3_BUCKET` — the bucket name
   - `S3_BUCKET_ENDPOINT` — `https://<account-id>.r2.cloudflarestorage.com`
   - `AWS_ACCESS_KEY_ID` — the R2 access key ID
   - `AWS_SECRET_ACCESS_KEY` — the R2 secret access key
   - `AWS_REGION` — `auto` (R2 requires this literal value)

### 1.3 JWT keypair

```bash
cd api
npm run keys:generate
```

The script writes `api/keys/private.pem` and `api/keys/public.pem` and prints
the base64 forms. Save both base64 strings in a password manager.

- `JWT_PRIVATE_KEY` → API service only
- `JWT_PUBLIC_KEY` → both services (used by the web for any future server-side
  token verification)

`api/.gitignore` already excludes `keys/`. Verify:

```bash
grep -E "^keys/" api/.gitignore
```

## 2. Deploy the API to Render

### 2.1 Push the Blueprint

`render.yaml` is at the repo root. Commit and push:

```bash
git add render.yaml api/.gitignore
git add api/src/config/env.ts api/src/lib/storage.ts api/src/app.ts
git add api/src/modules/auth/auth.controller.ts api/.env.example
git commit -m "deploy: render Blueprint for the API + cross-origin cookies"
git push origin main
```

### 2.2 Create the Blueprint

1. Render Dashboard → **New → Blueprint**.
2. Connect the GitHub repo.
3. Render reads `render.yaml` and shows `c4t-platform-api` on `plan: free`.
4. Click **Apply**.

Render creates the service. Deploys will fail until you fill in the secrets.

### 2.3 Paste the secrets

Dashboard → `c4t-platform-api` → **Environment** → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled URL |
| `DIRECT_DATABASE_URL` | Neon direct URL |
| `JWT_PRIVATE_KEY` | base64 of `private.pem` |
| `JWT_PUBLIC_KEY` | base64 of `public.pem` |
| `COOKIE_SAME_SITE` | `none` (cross-origin needs this) |
| `COOKIE_SECURE` | `true` (required when `COOKIE_SAME_SITE=none`) |
| `CORS_ORIGINS` | the Vercel domain (see §3 below) |
| `WEB_PUBLIC_URL` | the Vercel domain |
| `API_PUBLIC_URL` | `https://c4t-platform-api.onrender.com` |
| `S3_BUCKET` | bucket name |
| `S3_BUCKET_ENDPOINT` | R2 endpoint URL |
| `AWS_ACCESS_KEY_ID` | R2 access key |
| `AWS_SECRET_ACCESS_KEY` | R2 secret key |
| `GOOGLE_REDIRECT_URI` | `https://<render-api-domain>/v1/auth/google/callback` (the **Render** URL — `GET /v1/auth/google/callback` is handled by this API, not the web app; there is no rewrite forwarding it from Vercel) |
| `SEED_ADMIN_PASSWORD` | a real password |

### 2.4 First deploy

Render runs `prisma migrate deploy` during build (free tier doesn't support pre-deploy). Watch the **Logs** tab. When `/health/ready` returns 200, the API is up.

## 3. Deploy the web to Vercel

### 3.1 Configure Vercel

1. Vercel Dashboard → **New Project** → pick the repo.
2. Set the **Root Directory** to `web`.
3. Override the **Build Command** to `npm run build` (default is fine).
4. Override the **Output Directory** to `.next` (default is fine).

### 3.2 Set the environment variables

Project Settings → **Environment Variables** → add:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://<your-vercel-domain>` (the URL Vercel shows you, e.g. `https://c4t-platform.vercel.app`) |
| `NEXT_PUBLIC_API_BASE` | `https://c4t-platform-api.onrender.com` (this is the **full Render API URL** — no `/api/v1` prefix in cross-origin mode) |
| `NEXT_PUBLIC_ENVIRONMENT` | `production` |
| `API_ORIGIN` | `https://c4t-platform-api.onrender.com` (same as `NEXT_PUBLIC_API_BASE` — used by Server Components and Server Actions) |
| `JWT_PUBLIC_KEY` | base64 of `public.pem` (same value as on Render) |

Save and trigger a redeploy.

### 3.3 That's the only Vercel config

There is no `vercel.json` rewrite for `/api/v1/*` — the rewrite was removed from `next.config.ts` because it was only correct in the same-origin deploy. Vercel calls the API directly via `NEXT_PUBLIC_API_BASE`.

## 4. Smoke-test

```bash
# API health check
curl https://c4t-platform-api.onrender.com/health/ready
# Expected: {"status":"ready","database":"up"}

# Web home
curl -s -o /dev/null -w "%{http_code}\n" https://<your-vercel-domain>
# Expected: 200
```

Full sign-in flow:

1. Open `https://<your-vercel-domain>/login` in a browser.
2. Enter the seed admin credentials.
3. Browser should land on `/app/admin` (or your role's home).
4. Open browser dev tools → Application → Cookies. You should see `c4t_access` and `c4t_refresh` with `SameSite=None; Secure` set.
5. Hit a protected page (e.g. `/app/admin/leads`). It should render.

If the refresh cookie path is `/v1/auth` instead of `/api/v1/auth`, the API needs `REFRESH_COOKIE_PATH=/api/v1/auth` and a redeploy.

## 5. When something goes wrong

| Error | Cause | Fix |
|---|---|---|
| `STORAGE_DRIVER=local is not supported in production` | `STORAGE_DRIVER` is still `local` | Set to `s3` and confirm `S3_BUCKET`, `AWS_*` are set |
| `Invalid environment configuration: JWT_PRIVATE_KEY is required` | Missing or whitespace | Re-paste the base64 |
| `prisma migrate deploy` fails with `prepared statement already exists` | `DIRECT_DATABASE_URL` is the pooled endpoint | Use the **Direct** connection from Neon |
| CORS error in the browser | `CORS_ORIGINS` doesn't include the Vercel domain | Add `https://<your-vercel-domain>` to `CORS_ORIGINS` |
| Login works, refresh 401s | `REFRESH_COOKIE_PATH` is `/v1/auth` | Set to `/api/v1/auth` |
| Browser drops cookies silently | `SameSite=Lax` and cross-origin deploy | Set `COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true` |
| "Could not reach the sign-in service" on the web | `NEXT_PUBLIC_API_BASE` is wrong | Check the value matches the Render API URL exactly |
| `redirect_uri_mismatch` from Google | OAuth client's redirect URI doesn't match `GOOGLE_REDIRECT_URI` | Match exactly — use the **Render** API URL, not Vercel |

## 6. Production safety checklist

- [ ] `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` set on both services and match
- [ ] `SEED_ADMIN_PASSWORD` is a real password (not `ChangeMe!2026`)
- [ ] `REFRESH_COOKIE_PATH=/api/v1/auth` on the API service
- [ ] `COOKIE_SECURE=true` AND `COOKIE_SAME_SITE=none` on the API service
- [ ] `CORS_ORIGINS` includes the Vercel domain
- [ ] `STORAGE_DRIVER=s3` and `S3_BUCKET` set
- [ ] `GOOGLE_REDIRECT_URI` matches the registered redirect URI on the Google OAuth client (use the **Render** API URL, not Vercel)

## 7. Why this split

Compared to a single-host deploy, the cross-origin deploy has two new knobs:

1. **Cookies must be `SameSite=None; Secure`.** The browser silently drops `Lax` cookies across origins, so login appears to work and refresh 401s. The `env.ts` validator refuses `none` without `Secure`, so the misconfiguration is caught at boot.
2. **CORS must be configured.** The API's `CORS_ORIGINS` must include the Vercel domain. The browser enforces this even when `credentials: true`, so the API has to explicitly opt in.

The benefit is that the Vercel + Render split is the most natural pairing — Vercel is purpose-built for Next.js, Render is purpose-built for Node services. The cookies and CORS are the small cost of using the right tool for each.

## 8. How to roll back to a same-origin deploy

If you later move the API back to the same domain as the web (e.g. both on Render with a custom domain):

1. Edit `web/next.config.ts` and re-add the `/api/v1/:path*` rewrite that points at `API_ORIGIN`.
2. Set `NEXT_PUBLIC_API_BASE=/api/v1` on Vercel.
3. Set `COOKIE_SAME_SITE=lax` on the API (and drop `secure` if you want to allow `http://localhost`).
4. Set `COOKIE_DOMAIN=.crowd4test.com` on the API so the cookies cross subdomains.

The codebase already supports both modes — the only thing that changes is the env vars and the rewrite presence in `next.config.ts`.
