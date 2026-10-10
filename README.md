# Brick Finder

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
3. After a minute your app is at `https://<your-username>.github.io/friendly-goggles/`.
4. Open that link on your phone:
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**.

## One-time setup: Rebrickable key

The parts lists come from [Rebrickable](https://rebrickable.com), a free LEGO database.

1. Make a free account at rebrickable.com.
2. Go to **Settings → API** and tap **Generate new API key**.
3. Paste the key into the app when it asks.

## Credits

Parts lists and pictures: [Rebrickable](https://rebrickable.com). Piece recognition: [Brickognize](https://brickognize.com).
LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.
