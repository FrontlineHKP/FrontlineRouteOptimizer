# Eastern WA Cleaning Route Optimizer

Plan optimized routes for multiple cleaning teams across Eastern Washington, honor client frequency + time windows, and get smart reschedule suggestions. Google Maps integration for live maps/directions.

## Quick Start (no coding)

1. **Download the ZIP** included with this message and unzip it on your computer.
2. Create a free account at **vercel.com** and **github.com** (if you don't have them).
3. On GitHub, click **New repository** → Name it anything → **Create** → then click **Add file → Upload files**. Drag all the unzipped files/folders into GitHub and **Commit**.
4. On Vercel, click **Add New… → Project** → **Import Git Repository** → pick the repo you just created → accept defaults → **Deploy**.
5. After deploy, go to **Project → Settings → Environment Variables**, add:
   - **Name:** `VITE_GOOGLE_MAPS_API_KEY`
   - **Value:** your Google Maps JavaScript API key (instructions below)
   - **Environment:** Production & Preview
   Click **Save**, then **Redeploy** the latest build.
6. Open your live URL. You can also paste your API key in the app UI to test, but the env var is easiest long-term.

### Get a Google Maps API key
1. Go to https://console.cloud.google.com/ and create a project (free tier).
2. Search and **enable** these APIs: *Maps JavaScript API* and *Geocoding API*.
3. Go to **APIs & Services → Credentials → + Create Credentials → API key**. Copy the key.
4. (Optional) **Restrict** the key to your domain later for security.

## Local Run (optional)
If you prefer to try it locally:
1. Install Node.js 18+ from https://nodejs.org.
2. In a terminal, `cd` into the project folder.
3. Make a `.env.local` file with: `VITE_GOOGLE_MAPS_API_KEY=YOUR_KEY_HERE`
4. Run:
   ```bash
   npm install
   npm run dev
   ```
5. Open the shown URL in your browser.

## Notes
- Eastern WA bounds are enforced on the map.
- Frequencies supported: weekly, biweekly (aligned by week), monthly (first occurrence of preferred weekday).
- Reschedule suggestions use an insertion heuristic that shows the lowest added drive time.
- For enterprise-grade optimization (traffic and constraints), pair this UI with a small backend using Google Distance Matrix + OR-Tools.
