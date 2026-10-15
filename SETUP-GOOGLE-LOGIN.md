# Continue with Google — setup (3 steps)

1. **Supabase → Authentication → Sign In / Providers → Google → Enable.**
   In "Client IDs" paste the same Client ID that is in `supabase-config.js` (`GOOGLE_CLIENT_ID`).
   If it asks for a Client Secret, paste the secret from Google Cloud -> Clients -> your Web client.
   Save.
2. **Supabase → SQL Editor:** paste the contents of `supabase-google-login.sql` and run it once.
3. Google Cloud -> Clients -> Authorized JavaScript origins must contain your site
   (e.g. `https://social-nexus-trov.onrender.com`). Nothing else is needed.

Notes
- A Google account becomes its own SocialNexus account (new username, asked once).
- It is not merged with an older username/password account.
