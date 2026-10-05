# Chirag Mahajan — Portfolio

Product designer portfolio. A static site: plain HTML, CSS and JavaScript, no build step.

## What's in this folder

```
index.html                 Homepage
quick-chat.html            Quick Chat case study
quick-crm.html             Quick CRM case study
404.html                   Shown for broken links
support.js                 Page runtime (required, do not edit)
analytics.js               Google Analytics 4 + Microsoft Clarity, click/scroll events, noindex backup
motion.js                  Scroll reveals + case-study card tours (window → laptop morph on hover); off for reduced-motion visitors
hero-field.js              Interactive WebGL hexagon hero behind the headline
favicon.svg                Browser tab icon
robots.txt                 Lets crawlers read the pages (each page carries noindex, so the site stays out of search results)
assets/                    Images, logos and resume PDF
.nojekyll                  Tells GitHub Pages to serve files as they are
.github/workflows/static.yml   Publishes the site on every push to main
```

## Publish on GitHub Pages

1. Create a new repository on GitHub, for example `chirag-portfolio`.
   To have the site at `https://<your-username>.github.io/` instead, name the repository `<your-username>.github.io`.
2. Upload **everything inside this folder** (including the hidden `.github` folder and `.nojekyll`) to the repository root, on the `main` branch.
   From a terminal in this folder:
   ```
   git init
   git add .
   git commit -m "Portfolio site"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. The **Deploy static content to Pages** workflow runs on each push. After it finishes (about a minute), the site is live at
   `https://<your-username>.github.io/<repo-name>/`.

Prefer not to use Actions? In **Settings → Pages** choose **Deploy from a branch**, branch `main`, folder `/ (root)`. The workflow file can stay; it only runs when Pages is set to GitHub Actions.

## Update the site

Edit the files, then commit and push to `main`. The workflow republishes automatically.

- Resume: replace `assets/Chirag-Mahajan-Resume.pdf` with a file of the same name.
- Analytics IDs (GA4 + Microsoft Clarity) live at the top of `analytics.js`.
- Custom domain: add it under **Settings → Pages → Custom domain**, then point your DNS to GitHub Pages.

## Notes

- File names are case-sensitive on GitHub Pages. Keep image names exactly as they are referenced in the HTML.
- Light and dark mode follow the toggle in the navigation and are remembered per visitor.
