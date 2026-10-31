# GitHub OAuth App setup

AutoInfra uses one GitHub OAuth App for both "log in with GitHub" and the
minimal read-only repo scope needed to clone private repos for analysis.

1. Go to https://github.com/settings/developers → "New OAuth App".
2. Application name: `AutoInfra (dev)`.
3. Homepage URL: `http://localhost:3000`.
4. Authorization callback URL: `http://localhost:4000/auth/github/callback`.
5. Create the app, then generate a Client Secret.
6. Put the Client ID and Secret into `.env`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ```

Scope requested at login: `read:user` + `repo` (read access only is enforced at
the application layer -- AutoInfra never writes to the user's repos). Once
the app exists and `.env` has both values, visiting
`http://localhost:4000/auth/github` starts the flow: it logs you in (or
creates an account) if you have no session, or links GitHub to your current
account if you're already signed in -- same callback, both flows (see
`apps/api/src/routes/github.ts`). Without `GITHUB_CLIENT_ID`/
`GITHUB_CLIENT_SECRET` set, the API disables these routes at startup (logged
as a warning) rather than failing -- email+password auth still works.
