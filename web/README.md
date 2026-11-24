# FloorPoV web

This Next.js and Tailwind CSS starter will become the FloorPoV product site. The site will show what FloorPoV records, link to the Windows download, and guide players through their first recording.

## Run locally

Install [Bun](https://bun.sh/) and [Node.js](https://nodejs.org/) 20.9 or later. From the repository root, run:

```bash
cd web
bun install --frozen-lockfile
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the starter page. Edit `app/page.tsx` to change it.

From `web/`, run `bun run lint` to check the code and `bun run build` to verify the production build. The starter fetches the Geist fonts from Google Fonts when it compiles.

The web app has its own dependencies and lockfile. It does not use the Tauri build or the Windows release workflow. Hosting and browser-based analysis are outside this starter's scope.
