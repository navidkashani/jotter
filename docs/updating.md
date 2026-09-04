# Updating jotter

Your site is a copy of this repository, and nothing tells the copy when jotter
fixes something. This page is about closing the gap between "jotter fixed it"
and "your site has it".

## Fork, or template copy?

Both work; they differ in which button you get.

|  | Fork | Template copy |
| --- | --- | --- |
| Update button | GitHub's own **Sync fork** | **Actions → Update theme** |
| Can be private | **No, ever.** Fork visibility is tied to the repository network | Yes |
| Vault inside the repo | No: it would be public | Yes |
| How many | One fork per account per repo | As many as you like |

A fork is the simpler road when the site is public and the notes live in a
bucket. The workflow suits everything else: a private repository, a vault kept
in the repository, a second site, or a repository you already made from the
template.

**You cannot convert one into the other.** A template copy has no fork
relationship to create, and there is no setting for it. Check yours with
`gh repo view --json isFork`. Renaming your repository is safe either way, and
worth doing: `github.com/<you>/jotter` is a poor name for a personal site.

## Which jotter is your site running?

Every publish writes it to `/_publish.json`, and Obsidian reads it back:
**Settings → Open Publish → Build → Check**. The line reads "Site is live,
currently serving snapshot `2026-09-03T…`, built with jotter `<version>`".
Compare it against the [releases](https://github.com/navidkashani/jotter/releases)
and [CHANGELOG.md](../CHANGELOG.md). A site built before jotter learned to
report this says nothing after the snapshot, which means "older", not "broken".

## Why updating works at all

The five paths in [What you own](../README.md#what-you-own) are files you *add*
rather than files you edit, and jotter never writes to any of them. Both halves
matter. A build that rewrites a tracked file hands you a dirty working tree
whose obvious next move is `git commit -a`, and from then on every upstream
change to that path is a conflict. And editing `src/layouts/Base.astro`
conflicts with every release that touches it, while the same change as
`src/user/Head.astro` conflicts with nothing.

Which is why **deleting a file jotter ships is the one customisation to avoid.**
Git calls that a modify/delete conflict, and no button resolves it: every time
upstream edits the file you deleted, you are asked again. If you do not want the
demo garden, point `vault:` somewhere else and leave it alone.

## Taking an update

### The button

**Actions → Update theme → Run workflow.**

Your repository ships `.github/workflows/update-theme.yml`, which merges jotter
onto a branch called `update-theme` inside your own repository and gives you a
pull request to review. It never writes to your default branch.

The unrelated-histories rule is about pull requests *between* repositories, and
a branch in your own repository is not one. So the merge GitHub will not do for
a template copy is one a workflow can do inside your repo, passing the
`--allow-unrelated-histories` flag no button in the web UI passes.

Three things it can tell you, all on the run's own summary page:

- **Already up to date.** Nothing to do, and no empty pull request to close.
- **Ready to merge.** A link to the pull request. Read it, merge it, done.
- **Stopped: files disagree.** It names the files and changes nothing. See
  [Conflicts](#conflicts) below.

Two things GitHub withholds from a workflow by default:

- **Opening the pull request.** Off unless you tick Settings → Actions → General
  → Workflow permissions → *Allow GitHub Actions to create and approve pull
  requests*. Without it the workflow pushes the branch and hands you a link to
  open the pull request yourself.
- **Changing a workflow file.** The built-in token has no `workflows` scope and
  cannot be given one, so a push touching `.github/workflows/` is rejected by
  the server. Most updates do not touch these files. When one does, the run
  stops before merging and tells you.

### Giving the button a token

One-off, and it removes both limits at once, workflow files included.

1. [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new),
   scoped to **this repository only**, with **Contents: read and write**,
   **Pull requests: read and write** and **Workflows: read and write**.
2. Add it under Settings → Secrets and variables → Actions as `UPDATE_TOKEN`.

The workflow picks it up on its own (`secrets.UPDATE_TOKEN || secrets.GITHUB_TOKEN`).
Without it the button still works for every update that leaves
`.github/workflows/` alone, which is most of them.

### By hand, if you would rather

The same merge, in a terminal. Only the first one needs
`--allow-unrelated-histories`; after it plain `git merge upstream/main` works.

```bash
git remote add upstream https://github.com/navidkashani/jotter.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories

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

A conflict anywhere else is a bug in this page's promise. Please
[open an issue](https://github.com/navidkashani/jotter/issues) rather than
resolving it by hand and moving on.

### The one conflict that is possible, and usually is not there

The fetch used to rewrite `jotter.config.ts`, but it ran on the host's build
workspace, so for most sites that rewrite never reached a clone. It is in git
only if somebody ran a configured build locally (`OP_*` set) and committed the
result. If so, take upstream's copy:

```bash
git checkout --theirs jotter.config.ts
```

Your settings are not in that file. They are in Obsidian, and they arrive on
your next publish in `.jotter/site.json`, which nothing tracks.

## For maintainers: what upstream may never do

Once anybody's repository has this one as an ancestor, three things upstream can
do will break their update permanently, and none of them announces itself:

- **No force-push to `main`.** A rewritten tip is the one thing a fork sync
  cannot survive. This is also why the Quartz starter is not offered as a fork:
  `assemble.mjs` regenerates and force-pushes that repository by design.
- **No renaming the default branch.**
- **No renaming or moving the repository.** A redirect keeps `git fetch`
  working, and does not survive the repository being deleted or the name reused.

Nothing else is off limits. Deleting a file, renaming a component or changing a
config key produce ordinary conflicts in files nobody downstream should have
edited, and the CHANGELOG's job is to say so.
