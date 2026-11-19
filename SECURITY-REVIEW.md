# Security review before publishing

Go through this for every change that touches identity, public routes, AI
tools, connections, settings or database queries. A reviewer checks the same
things before approving a version.

## Identity

- [ ] Every page or action that changes data checks `x-altstack-owner-id`.
- [ ] Owner/admin-only actions (settings, deleting, connecting accounts) also check `x-altstack-role`.
- [ ] Identity comes only from `x-altstack-*` headers, never from a cookie, query
      parameter or form field the client sent.
- [ ] There's no login, password or session code of the app's own.

## Public routes

- [ ] Each route that works without a signed-in user is meant to be public
      (a landing page, a form visitors fill in, a provider's webhook).
- [ ] Public routes that accept data validate it and cap its size.
- [ ] A webhook you receive directly (not via `/_altstack/webhooks/`) verifies the sender's signature.

## AI tools

- [ ] Each tool's `risk` is honest: anything that deletes or can't be undone is `destructive`.
- [ ] Tools check `x-altstack-role` the same way the matching page does.
- [ ] Tool results don't include secrets or settings values.

## Data and permissions

- [ ] SQL uses `.bind()` for every value; no string-built queries with user input.
- [ ] Each `egress` host, connection and service has a `why` a buyer would accept.
- [ ] No API keys, tokens or passwords in code; per-buyer secrets are `secret: true` settings.
- [ ] New migrations only add; they don't rewrite or drop data earlier versions wrote.
