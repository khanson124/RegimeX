# Security

## Authentication

- Passwords hashed with **Argon2id** (via `argon2` package)
- **JWT access tokens** (short TTL, default 15 min)
- **Refresh tokens** stored hashed in DB with rotation families
- Reuse of revoked refresh token revokes entire family
- Rate limiting on auth and Deriv connect endpoints
- Brute-force protection via `@fastify/rate-limit` + Redis

## Credential encryption

Deriv API tokens encrypted with **AES-256-GCM**:

- Key: `CREDENTIAL_ENCRYPTION_KEY` (32-byte hex or base64)
- Implementation: `packages/config/src/crypto.ts`
- Storage: `DerivCredential.encryptedToken` (iv:tag:ciphertext, base64)
- Decryption only in API/worker — never sent to mobile

## Demo-only enforcement

| Layer | Control |
|-------|---------|
| Deriv connect | Rejects `is_virtual !== 1` |
| Risk profile | `demoOnly` forced `true` on update |
| Environment | `DEMO_TRADING_ENABLED=false` by default |
| Mobile UI | Demo trading selector disabled when server flag off |
| Engine | `RUNNING_DEMO_TRADING` requires both flags |

Live-money trading paths are not implemented.

## API security

- `@fastify/helmet` security headers
- CORS restricted via `CORS_ORIGINS`
- Request body limit 256 KiB
- All payloads validated with Zod
- Ownership checks on every user-scoped resource
- Structured logs redact tokens, passwords, authorization headers

## WebSocket

- Authenticated via JWT query parameter
- No sensitive credentials in event payloads
- Throttled high-frequency market events

## Strategy safety

- Strategies are **typed configuration objects**, not executable user code
- No `eval`, no user-submitted JavaScript
- Optimizer combination count guarded (`OPTIMIZER_MAX_COMBINATIONS`)

## Error handling

Typed errors (`AuthenticationError`, `ValidationError`, etc.) return safe messages to clients. Stack traces never leak to mobile.

## Production checklist

- [ ] Rotate all secrets from `.env.example` placeholders
- [ ] HTTPS via Nginx + Let's Encrypt
- [ ] PostgreSQL and Redis not publicly exposed
- [ ] `CORS_ORIGINS` set to specific mobile/web origins
- [ ] `DEMO_TRADING_ENABLED=false` until deliberately enabled
- [ ] AWS budget alerts configured
- [ ] Database backups scheduled
