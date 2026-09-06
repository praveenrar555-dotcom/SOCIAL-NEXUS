# SocialNexus — Phase 1 (Features 1–10)

Plain HTML/CSS/JS, no build step, talks directly to Supabase.

## What's included
- `index.html` — page structure
- `style.css` — design system (ink + aurora theme)
- `supabase-config.js` — put your Supabase URL + anon key here
- `app.js` — all the logic: auth, feed, carousel, reels, pinned post,
  hashtags/explore, stories + reverse reveal + reply-to-DM, on this day,
  DM chat
- `socialnexus_phase1_schema.sql` — run this first in Supabase
- `socialnexus_phase1_addendum.sql` — run this second (DM helper function)

## Setup (10 minutes)
1. Create a project at supabase.com (free tier is fine).
2. Go to **SQL Editor** → paste and run `socialnexus_phase1_schema.sql`.
3. Run `socialnexus_phase1_addendum.sql` the same way.
4. Go to **Storage** → create two buckets: `post-media` and `story-media`.
   Mark both as **public** buckets (read access) when creating them —
   the RLS policies from the schema handle who can *upload*.
5. Go to **Authentication → Providers** → make sure Email is enabled.
   (Optional: turn off "Confirm email" while testing locally, so you
   don't need to click an email link after every signup.)
6. Go to **Project Settings → API** → copy the **Project URL** and the
   **anon public** key into `supabase-config.js`. Never use the
   `service_role` key here.

## Run locally
Just open `index.html` in a browser, or serve the folder with any
static server (e.g. `npx serve .`).

## Deploy
- **GitHub**: push this folder as a repo. Add a `.gitignore` if you
  later add any file with real secrets in it (there shouldn't be any —
  the anon key is safe to expose, it's designed for the browser).
- **Render**: create a new **Static Site**, point it at the GitHub repo,
  leave build command empty, set publish directory to `.` (or wherever
  these files live in the repo).

## Known simplifications (fine for Phase 1, worth revisiting later)
- Hashtag counts on the Explore page do one query per tag — fine at
  small scale, swap for a Postgres view/RPC once you have many tags.
- Story auto-advance timer doesn't pause while reverse-reveal is held.
- "On This Day" scans all of a user's own posts client-side — fine
  personally, would want a DB-side date filter at larger scale.
- Chat has no realtime yet (messages load on open/send) — Supabase
  Realtime subscriptions are a natural next addition.
- No image/video compression before upload yet — consider capping
  file size client-side so people don't upload huge files.
