# Security

Please report vulnerabilities through GitHub's private vulnerability reporting (the Security tab), not a public issue.

## How it works

- **The owner** signs in with Google. Only `ALLOWED_EMAIL` is accepted, and the flow uses PKCE, state and nonce checks.
- **Sessions** are HMAC-signed with a random key kept in SSM. Web sessions last 12 hours and app sessions last 90 days. Rotating `/<prefix>/session-key` signs everyone out.
- **Secrets** live in SSM as SecureStrings. None are in this repository or in the Lambda's environment.
- **Visitors** are anonymous. A visitor id is only a random string, so anyone holding it can read that one conversation. It's kept in the visitor's browser.
- **Email conversations** (optional) get an id made from the sender's address, which is not a secret. Ids of that shape are refused on the visitor socket and on the visitor data endpoints, so only the signed-in owner can read them.
- **Cross-site requests:** the session cookie is `SameSite=Lax`, and with a cookie every request that changes something must be `content-type: application/json`, which another site's form can't send.
- **Origins:** the visitor socket only accepts sites in `ALLOWED_ORIGINS`. Browsers enforce this, but other clients can fake an `Origin`, which is why the rate limits also exist.

## Keeping your deployment private

`deploy.env`, `ios/Local.xcconfig`, `.private-patterns` and `*.p8` are gitignored. Run `npm run check:public` before pushing a fork. It looks for key shapes, private files, and any strings you list in `.private-patterns`, one regex per line.

The local bench signs everyone in as the owner, so it binds to loopback only. Don't expose it.
