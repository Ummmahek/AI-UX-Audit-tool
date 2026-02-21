# GitHub version control setup

Your project already has Git initialized. Follow these steps to put it on GitHub.

---

## 1. Create a new repository on GitHub

1. Go to **https://github.com/new**
2. **Repository name:** e.g. `next-ux-audit` (or any name you like)
3. **Description:** optional, e.g. "UX audit report generator (Next.js)"
4. Choose **Private** or **Public**
5. **Do not** check "Add a README" or "Add .gitignore" (you already have them)
6. Click **Create repository**

---

## 2. Connect this folder to GitHub

In PowerShell (or Terminal), from this project folder run:

```powershell
cd "c:\Users\Mahek\Desktop\digital of things\ux audit demo\next-ux-audit"

# Add GitHub as remote (replace YOUR_USERNAME and REPO_NAME with your actual GitHub repo)
git remote add origin https://github.com/YOUR_USERNAME/REPO_NAME.git
```

Example if your GitHub username is `mahek` and repo name is `next-ux-audit`:

```powershell
git remote add origin https://github.com/mahek/next-ux-audit.git
```

---

## 3. Commit your code and push

```powershell
# Stage all project files (respects .gitignore)
git add .

# Commit
git commit -m "Add UX audit tool: crawl, RAG, validation, report download"

# Push to GitHub (first time: set upstream branch)
git push -u origin main
```

If your default branch is `master` instead of `main`:

```powershell
git push -u origin master
```

---

## 4. Important notes

- **`.env.local`** is ignored by `.gitignore` — your API keys will **not** be pushed. Keep it that way.
- **Report files** (e.g. `.pptx`, `.doc`) in the project root are now ignored so they don’t get committed.
- After the first push, use:
  - `git add .`
  - `git commit -m "Your message"`
  - `git push`
  whenever you want to save a new version to GitHub.

---

## 5. If you already have a remote

If you had added a remote before, either use it or replace it:

```powershell
# See current remote
git remote -v

# Change URL if needed
git remote set-url origin https://github.com/YOUR_USERNAME/REPO_NAME.git
```
