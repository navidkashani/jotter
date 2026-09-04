# Obsidian syntax

| Syntax | Behaviour |
| --- | --- |
| `[[Note]]`, `[[Note\|Alias]]` | Resolved by shortest path, case-insensitively, through aliases |
| `[[Note#Heading]]` | Links to the heading anchor, rendered `Note > Heading` |
| `[[Note#^block]]` | Links to the note; block anchors are out of scope |
| `![[image.png]]` | Optimized to AVIF/WebP with intrinsic dimensions |
| `![[image.png\|300]]`, `\|400x200` | A number is a **size** |
| `![[image.png\|Caption]]` | Anything else is a **caption**, giving a `<figure>` |
| `![[clip.mp4]]`, `![[song.mp3]]` | `<video>` / `<audio controls preload="metadata">` |
| `![[paper.pdf]]` | A named file card linking to the document. See below |
| `![](https://…/photo.png)` | A remote `<img>`, left where the author pointed it |
| `![](https://youtube.com/watch?v=…)` | A link. jotter embeds no third-party player. See below |
| `![[Note]]`, `![[Note#Section]]` | Transcluded inline, depth-limited, cycle-guarded |
| `> [!note] Title`, `[!x]-`, `[!x]+` | Callouts, collapsible variants native `<details>` |
| `==highlight==` | `<mark>` |
| `%%comment%%` | Stripped |
| `#tag`, `#nested/tag` | Chips linking to hierarchical tag pages |
| Single newline | `<br>` unless `strictLineBreaks: true` |
| Tables, footnotes, task lists, strikethrough | GFM |

**Out of scope, deliberately:** Dataview, `.canvas`, Excalidraw, stacked notes,
comments, Mermaid, KaTeX rendering.

## Embeds render as the kind of thing their target is

**A PDF is a link, not an inline viewer.** An embedded viewer downloads the
whole document on page load for a reader who was only skimming, and renders as a
blank box or an unturnable first page on mobile. The card carries the file's
name and extension, so a reader knows what they are opening.

**A remote URL that names no image never becomes an `<iframe>`.**
`![](https://youtube.com/watch?v=…)` renders an embedded player in Obsidian, and
doing that here would put Google's frame, cookies and scripts on the page of
every reader who never pressed play.

What you get instead is a placeholder image with a play button and a link to the
video. The player is fetched only when a reader clicks, so until then the built
page has requested nothing from anybody. The poster image is local:
`scripts/fetch-content.mjs` downloads it into the vault at build time. A poster
that could not be fetched leaves the placeholder in place without one.

An X post is fetched the same way, through `publish.x.com/oembed` with
`omit_script=1`, and rendered as jotter's own markup from the text and the
byline. There is nothing to sanitise and no widget script. A tweet nobody could
fetch is a link to the tweet, never an invented one.

Everything else remote is a card naming the host and the path. Anything ending
in an image extension is still an `<img>`. `features.embeds: false` turns the
lot back into link cards.

## An authoritative link index

If `.jotter/links.json` exists at the top of your vault, it short-circuits
resolution for every link it names.

That file is meant to be written by something that could see the **whole** vault
(Obsidian itself, or a plugin), because a site generator only ever sees the
published subset. It cannot reproduce attachment folders, aliases and
shortest-path matching over notes that were never published.

```json
{
  "Notes/Home.md": [
    { "raw": "Zettelkasten", "status": "published", "slug": "notes/zettelkasten" },
    { "raw": "Private Log",  "status": "unpublished" }
  ]
}
```

Links the file does not name fall back to `linkResolution`. A malformed file is
a warning rather than a failed build, and an entry naming a slug this build does
not have falls back rather than emitting a link to a page that will not exist.

[Open Publish](https://github.com/navidkashani/open-publish) writes exactly this
file. `npm run build` can pull a published snapshot straight out of its bucket,
with notes, attachments, resolved links and site options, using four
environment variables and no code change. It does nothing when they are not set.
See [open-publish.md](open-publish.md).
