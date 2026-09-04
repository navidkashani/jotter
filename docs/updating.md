# Updating jotter

Your site is a copy of this repository. When jotter fixes something, nothing
tells the copy — so this page is about making the gap between "jotter fixed it"
and "your site has it" as small as possible.

## Fork, or template copy?

Both work; they differ in which button you get.

|  | Fork | Template copy |
| --- | --- | --- |
| Update button | GitHub's own **Sync fork** | **Actions → Update theme** |
| Can be private | **No, ever.** Fork visibility is tied to the repository network | Yes |
| Vault inside the repo | No — it would be public | Yes |
| How many | One fork per account per repo | As many as you like |

A fork is the simpler road when the site is public and the notes live in a
bucket. Everything else — a private repository, a vault kept in the repository,
a second site, or a repository you already made from the template — wants the
workflow.

**You cannot convert one into the other.** A template copy has no fork
relationship to create, and there is no setting for it; check yours with
`gh repo view --json isFork`. That is not much of a loss: the workflow is the
same merge with one more click.

Renaming your repository is safe either way, and worth doing —
`github.com/<you>/jotter` is a poor name for a personal site.

---

## Which jotter is your site running?

Every publish writes it to `/_publish.json`, and Obsidian reads it back:
**Settings → Open Publish → Build → Check**. The line reads

> Site is live, currently serving snapshot `2026-09-03T…`, built with jotter 1.4.

Compare it against the [releases](https://github.com/navidkashani/jotter/releases)
and [CHANGELOG.md](../CHANGELOG.md). A site built before jotter learned to report
this says nothing after the snapshot; that means "older than 1.4", not "broken".

---

## What is yours, and why updating works at all

| Path | What it is |
| --- | --- |
| `jotter.config.ts` | Site settings. **Never written by the build.** |
| `src/styles/custom.css` | Your CSS. Loads last. |
| `src/user/*.astro` | Your own Header, Sidebar, Head, Footer, Frontmatter, PrevNext. |
| `src/i18n/*.json` | Your translations. No list to register them in. |
| your vault folder | Wherever `vault:` points. |

**jotter never writes to any of them**, and each one is a file *added* rather
than a file *edited*. Both halves matter. A build that rewrites a tracked file
hands you a dirty working tree whose obvious next move is `git commit -a`, and
from then on every upstream change to that path is a conflict. And a
customisation made by editing `src/layouts/Base.astro` conflicts with every
release that touches `Base.astro`, which is most of them; the same
customisation as `src/user/Head.astro` conflicts with nothing, ever, because
upstream has no copy of that file to disagree with.

Which is also why **deleting a file jotter ships is the one customisation to
avoid.** Git calls that a modify/delete conflict, and it is the kind no button
resolves: every time upstream edits the file you deleted, you are asked again.
If you do not want the demo garden, point `vault:` somewhere else and leave it
alone. It costs nothing — nothing outside your vault folder is built.

---

## Taking an update

### The button

**Actions → Update theme → Run workflow.**

Your repository ships `.github/workflows/update-theme.yml`, which merges jotter
onto a branch called `update-theme` inside your own repository and gives you a
pull request to review. It never writes to your default branch.

That indirection is the point. A repository made with **Use this template**
starts from a single commit, so its history is unrelated to jotter's: GitHub
shows no "Sync fork" button and refuses to open a pull request between the two.
But the unrelated-histories rule is about pull requests *between repositories*,
and a branch in your own repository is not one — so the merge that GitHub will
not do for you is one a workflow can do inside your repo, passing the
`--allow-unrelated-histories` flag no button in the web UI passes.

Three things it can tell you, all on the run's own summary page:

- **Already up to date** — nothing to do, and no empty pull request to close.
- **Ready to merge** — a link to the pull request. Read it, merge it, done.
- **Stopped: files disagree** — it names the files and changes nothing. See
  [Conflicts](#conflicts) below.

By default GitHub does not let a workflow open a pull request
(Settings → Actions → General → Workflow permissions → *Allow GitHub Actions to
create and approve pull requests*, off unless you tick it). The workflow does not
fail on that: it pushes the branch anyway and hands you a link to open the pull
request yourself. Ticking the box removes the click.

### By hand, if you would rather

The same merge, in a terminal. The first one needs `--allow-unrelated-histories`
for the reason above; after it the histories are related and plain
`git merge upstream/main` works:

```bash
git remote add upstream https://github.com/navidkashani/jotter.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories
```

Then:

```bash
npm install          # in case dependencies moved
npm run build        # or just push and let your host build it
```

### Conflicts

Conflicts should only ever land in the files in the table above. Keep yours, take
upstream's for everything else:

```bash
git checkout --theirs src/layouts/Base.astro   # upstream's copy of a file you did not mean to own
git checkout --ours   src/styles/custom.css    # yours
```

If a conflict lands anywhere else, that is a bug in this page's promise; please
[open an issue](https://github.com/navidkashani/jotter/issues) rather than
resolving it by hand and moving on.

### The one conflict that is possible, and usually is not there

The fetch used to rewrite `jotter.config.ts`, but it ran on the host's build
workspace, so for most sites that rewrite never reached a clone and the
`.jotter/` release merges cleanly.

It is in git only if somebody ran a configured build locally (`OP_*` set) and
committed the result. If so, that file is the one path that conflicts, because
the release edits it too. Take upstream's copy:

```bash
git checkout --theirs jotter.config.ts
```

Your settings are not in that file. They are in Obsidian, and they arrive on
your next publish, in `.jotter/site.json`, which nothing tracks.

---

## For maintainers: what upstream may never do

Once anybody's repository has this one as an ancestor — a fork, or a template
copy with an `upstream` remote — three things upstream can do will break their
update permanently, and none of them announces itself:

- **No force-push to `main`.** A rewritten tip is the one thing a fork sync
  cannot survive, and it turns every downstream merge into a conflict against
  commits that no longer exist. This is also why the Quartz starter is not
  offered as a fork: `assemble.mjs` regenerates and force-pushes that repository
  by design.
- **No renaming the default branch.**
- **No renaming or moving the repository.** A redirect keeps `git fetch` working;
  it does not survive the repository being deleted or the name being reused.

Nothing else is off limits. Deleting a file, renaming a component, changing a
config key — those are ordinary changes that produce ordinary conflicts in files
nobody downstream should have edited, and the CHANGELOG's job is to say so.
