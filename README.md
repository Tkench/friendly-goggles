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

## One-time setup: Rebrickable key

The parts lists come from [Rebrickable](https://rebrickable.com), a free LEGO database.

1. Make a free account at rebrickable.com.
2. Go to **Settings → API** and tap **Generate new API key**.
3. Paste the key into the app when it asks.

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
