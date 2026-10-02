# RegimeX workflow

- Make source and configuration changes in the local repository first.
- Validate locally, commit, and push through Git before updating the server checkout.
- Keep local and server source code on the same approved commit; do not implement directly on the server.
- Treat deployment as a separate action requiring explicit user authorization. Syncing Git does not authorize builds, restarts, or engine control.
- Preserve server-only secrets, runtime state, caches, and generated research data; do not commit them while synchronizing code.
