# Safety-First Lane Change — Demo (static web)

Lightweight demo of a Depth-Limited Search (DLS) safety critic for lane-change verification.
This is a static web app (Three.js + Web Worker) intended for demo / review. Deployable to Vercel or any static host.

## Files
- `index.html` — main page
- `styles.css` — styling
- `app.js` — main UI and 3D visualization (imports Three.js from CDN)
- `dls_worker.js` — Web Worker that runs the DLS safety check
- `README.md` — this file

## How to run locally
1. Clone the repo.
2. Serve the folder with a static server (Web Workers require http(s)):
   - Python 3: `python -m http.server 5500`
   - Then open `http://localhost:5500` in the browser
3. Click a scenario, then **Run Safety Check**. The verdict and counterexample (if any) are shown.

## How to deploy to Vercel (recommended)
1. Create a new GitHub repo and push these files.
2. Log into https://vercel.com and import the GitHub repository.
3. Choose "Framework: Other (Static Site)" or leave defaults and deploy.
4. Vercel will serve the static site; open the produced URL.

## Demo notes for mentors
- The demo runs a DLS verifier for a short horizon (2.0 s, Δt=0.5s).
- We branch only on the critical follower in the target lane to keep runtime demo-friendly.
- Counterexample trace animates to show the requiring sequence (the neighbor action causing unsafe).

## License
MIT — free to use in project demo. No warranties.
