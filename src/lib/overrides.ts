/**
 * Your own component in place of one of jotter's, without editing one of
 * jotter's.
 *
 * Drop `src/user/Header.astro` beside this theme and it renders instead of
 * `src/components/Header.astro`. Nothing is registered, imported or configured;
 * the file's presence is the whole mechanism, and its absence costs a build
 * nothing.
 *
 * ## Why a directory nobody upstream writes to
 *
 * The alternative is what jotter used to advise: paste your snippet into
 * `src/layouts/Base.astro`. That file is one of the most-edited in the repo, so
 * the advice amounted to "put your code in the path most likely to conflict with
 * every update you ever take". `src/user/` is a directory this repository will
 * never add a file to, which makes a file in it un-conflictable by construction.
 *
 * ## Why a glob rather than a config key
 *
 * `import.meta.glob` resolves to `{}` when nothing matches, so a missing
 * override is not an error to handle: it is `null`, and the caller falls back
 * with `??`. A config key naming the overrides would need the same file to exist
 * *and* be listed, which is two ways to get it wrong instead of none.
 *
 * The pattern **must be a static string literal** — Vite resolves it at build
 * time, so it cannot be built from a variable. The lookup key below can be, and
 * is: that is the half that varies.
 *
 * ## The slots, and why the list is short
 *
 * `Base.astro` looks for `Header`, `Sidebar`, `Head` and `Footer`;
 * `Note.astro` looks for `Frontmatter` and `PrevNext`. Every one of them is a
 * whole region of the page with a clear edge. Slots are added when somebody
 * needs one, not in anticipation: each is a promise about markup that upstream
 * then has to keep, and a promise nobody is using is one that gets broken
 * without anybody noticing.
 *
 * `Head` and `Footer` have no jotter component behind them. They are pure
 * additions: `Head` renders last in `<head>` (where an analytics snippet or a
 * verification tag goes) and `Footer` after `<main>`.
 */

/**
 * Deliberately loose. An override takes whatever props the component it
 * replaces takes, and those differ per slot: `Sidebar` gets `current`,
 * `PrevNext` gets `previous` and `next`, `Head` gets nothing. Typing this as
 * any one component's factory would make every other slot a type error, and
 * there is no shared shape to name instead. The check that matters is the one
 * TypeScript cannot do anyway: that somebody's own component renders.
 */
type UserComponent = any

const modules = import.meta.glob('../user/*.astro', { eager: true }) as Record<
  string,
  { default: UserComponent }
>

/**
 * The override for a slot, or `null`. Callers spell that `override('Header') ?? Header`.
 */
export function override(name: string): UserComponent | null {
  return modules[`../user/${name}.astro`]?.default ?? null
}
