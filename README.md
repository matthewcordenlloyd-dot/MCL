# MCL
Where I post my discoveries on Claude: things I've built with Claude Code.

## Projects

| Project | What it is | Built with |
|---|---|---|
| [Sky Empire](sky-empire/) | 3D open-world airline empire game in the browser. Run an airline from London, walk the airports and fly the planes yourself. | Claude Code, three.js, Blender, TypeScript |

## Running a project

Each project has its own README with setup steps. For Sky Empire:

```powershell
cd sky-empire
npm install
npm run dev
```

Then open http://localhost:5173 in Chrome or Edge.

## Security

This repo contains no passwords, API keys or tokens. Optional keys (like a MapTiler key for sharper satellite imagery) go in a local `.env.local` file, which `.gitignore` keeps out of the repo. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
