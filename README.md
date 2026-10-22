# Last Brick

A phone app for rebuilding old LEGO sets from a big pile of mixed bricks.

- **Add a set by number** (e.g. `6080`). The app downloads the parts list (the same one printed at the back of the manual) with a **picture of every piece**, its colour and part number.
- **Tick off what you have.** For sets that are nearly complete, choose *Mostly complete* and untick only the missing pieces.
- **Looking for**: every missing piece from all your sets in one place. View it as a list (with which set needs it) or as a grid of pictures, filter by colour while sorting a pile, and search by name or part number. Tap **Found** to add a piece to the right set.
- **Scan**: take a photo of a single piece. The app recognises it and tells you whether one of your sets needs it, and which one.
- Works offline once loaded (part pictures are cached), and can be installed on your home screen.
- Your progress is saved on your phone. Use *Settings → Download backup* now and then.

## Getting it on your phone

The app is plain HTML/JavaScript with no build step, so GitHub Pages can host it for free:

1. On GitHub open this repo → **Settings → Pages**.
2. Under *Build and deployment* choose **Deploy from a branch**, pick the branch (e.g. `main`) and folder **/ (root)**, then **Save**.
3. After a minute your app is at `https://<your-username>.github.io/lastbrick/`.
4. Open that link on your phone:
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**.

## Parts-list lookup (no key needed by users)

Parts lists come from [Rebrickable](https://rebrickable.com). The app gets them through a small Supabase Edge Function, [`supabase/functions/rebrickable`](supabase/functions/rebrickable/index.ts), which holds the Rebrickable key as a secret and caches every parts list in the `set_cache` table so each set is fetched from Rebrickable only once. The same helper also looks up minifigures (search, the pieces in a figure, the sets it came in, and which figures use a scanned piece).

1. Run [`supabase/set_cache.sql`](supabase/set_cache.sql) in the Supabase SQL Editor.
2. Supabase → **Edge Functions → Deploy a new function → Via Editor**, name it `rebrickable`, paste in `index.ts` and deploy. In the function's settings turn **off** "Enforce JWT verification" (people use the app without logging in).
3. Supabase → **Edge Functions → Secrets**: add `REBRICKABLE_KEY` with a key from rebrickable.com → Settings → API.

Until the function is deployed, the app falls back to a personal Rebrickable key entered under Settings → Advanced.

## Problem reports

"Wrong match? Tell us" (after a scan) and Settings → **Report a problem** save reports to a `reports` table, with what the scanner guessed and what the app showed. Run [`supabase/reports.sql`](supabase/reports.sql) in the SQL Editor once; reports then appear under **Table Editor → reports**. Anyone can send a report, but nobody can read them through the app.

## Visit counter and Stats page

The app records one visit per device per day (just the date and three yes/no answers: new visitor, logged in, installed; nothing identifying). Accounts listed in the `admins` table get a **Stats** page under Settings: visitors, sign-ups, popular sets and minifigures, most-wanted pieces and recent problem reports. Run [`supabase/stats.sql`](supabase/stats.sql) once in the SQL Editor (it adds the first admin).

## Login, backup and sync (optional)

Accounts use [Supabase](https://supabase.com) (free plan). Until it's set up the app works exactly as before, with everything stored on the phone.

1. Create a free account at supabase.com and a **New project** (pick the **London** region and save the database password somewhere safe).
2. Open **SQL Editor → New query**, paste the contents of [`supabase/setup.sql`](supabase/setup.sql) and press **Run**.
3. Open **Authentication → URL Configuration** and set **Site URL** to the app's address, e.g. `https://<your-username>.github.io/lastbrick/` (also add it under **Redirect URLs**). This is where the "confirm your email" and "reset password" links send people back to.
4. Open **Project Settings → API** and copy the **Project URL** and the **anon / public** key into `SUPABASE_URL` and `SUPABASE_KEY` at the top of `app.js`. The anon key is designed to be public; row-level security means each person can only read and change their own data.

Free Supabase projects pause after about a week with no activity; if that happens, press **Restore** on the project in the Supabase dashboard.

## Credits

Parts lists and pictures: [Rebrickable](https://rebrickable.com). Piece recognition: [Brickognize](https://brickognize.com).
LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.
