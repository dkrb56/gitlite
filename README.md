# GitLite

A small visual git client. Three columns: repositories, history graph with commit
details below it, and the selected file's diff.

## Download

Get the newest build from [Releases](https://github.com/dkrb56/gitlite/releases/latest):

- `GitLite-<version>-portable.exe` — Windows, no installation. Needs `git` on the PATH.

## Run from source

```bash
npm install
npm run dev
```

`npm run dev` compiles the main process, starts Vite, and opens Electron against the
dev server with DevTools detached. `npm start` builds everything and runs the built app.

## Share as a portable exe

Run `npm run dist`. It builds `dist\GitLite-<version>-portable.exe`: one file that runs
without installation on 64-bit Windows.

- The exe has no personal data and stores its repository list in the user's AppData folder.
- The exe is not code-signed, so Windows SmartScreen can warn on the first start. Click
  **More info**, then **Run anyway**.
- Each start unpacks the app to a temporary folder, so it starts a few seconds slower than
  running from source.

## Features

- Repository list, persisted in the app's user-data folder.
- Commit graph with lanes, merges, and labels for HEAD, branches, remotes and tags.
- "Uncommitted changes" row at the top of the graph when the working copy is dirty.
- Commit details: hash, author, date, parents (clickable), message, changed files.
- Working copy: staged and unstaged lists, stage / unstage / discard per file or all,
  commit message box.
- Unified diff with old/new line numbers for any file in a commit or the working copy.
- Toolbar: branch pill with a popover to switch local or remote branches or create one, fetch, pull, push.
- Settings sheet: light or dark theme, accent color, relative or absolute dates, diff text size. Saved in the app.
- Draggable splitters between the middle column and the diff, and between graph and details.
- Up/Down arrows move the commit selection when the history pane has focus.
- The view refreshes after every action and whenever the window regains focus.

## Layout

```
src/main/      Electron main process: window, IPC handlers, git CLI wrapper, repo store
src/preload/   contextBridge that exposes window.git to the renderer
src/renderer/  Plain TypeScript UI built by Vite (graph layout, diff rendering, panes)
src/shared/    Types shared by all three
```

All git operations shell out to the `git` executable on PATH. The history is capped at
2000 commits. Compiled code goes to `out/`; `dist/` holds release builds only.

## Not included yet

- Hunk or line staging (only whole files).
- Stash, rebase, merge, cherry-pick, tags, and conflict resolution.
- Side-by-side diff and syntax highlighting.
- Credential prompts: pushes and pulls rely on a credential helper already set up for git.

## License

GitLite is released under the [MIT License](LICENSE). It includes open-source software
from other projects; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Each build
ships both files. GitLite does not include git itself; it runs the git installed on the
computer.
