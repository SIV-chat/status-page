# Siv status page

Independent public health checks for Siv's production application, API, and
website. The generated site is served at
<https://sivintelligence.se/status/>.

## Repository layout

- `site/` contains the static browser source.
- `scripts/build-status-page.ts` checks the public endpoints and builds `dist/`.
- `.github/workflows/status-page.yml` runs every five minutes and deploys the
  generated artifact with GitHub's official Pages actions.
- The `gh-pages` branch mirrors the generated artifact so
  `status/history.json` can retain 90 days of observed check results.

No Siv credentials, cookies, customer data, or private platform source belong
in this repository. The workflow uses only its scoped `GITHUB_TOKEN`; it does
not require a deploy key or repository secret.

## Local verification

```fish
bun test
bun run build
```

The build command performs the real public health checks. Tests use mocked HTTP
responses.

## One-time GitHub Pages setup

1. Keep this repository public.
2. Allow GitHub Actions to use read and write workflow permissions for this
   repository.
3. Put the workflow on the default `main` branch and run **Publish Status Page**
   manually once.
4. Keep GitHub Pages configured with **GitHub Actions** as its publishing
   source.
5. Verify `sivintelligence.se` for the `SIV-chat` organization, configure it as
   the Pages custom domain, retain the verification TXT record, and point the
   apex DNS records to GitHub Pages. Do not configure wildcard DNS.

The generated root page redirects to `/status/`.
