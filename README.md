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
- Hunk and line staging: every hunk header in a working-copy diff has Stage / Unstage and
  Discard buttons. Click changed lines (Shift-click for a range) to stage, unstage or discard
  only those lines.
- Unified or side-by-side diff with old/new line numbers, syntax colors for common languages,
  for any file in a commit, a stash or the working copy.
- Stash: the toolbar button stashes the working copy (optionally with untracked files). Stashes
  are listed in the sidebar; select one to see its files and Apply, Pop or Drop it.
- Merge, rebase, cherry-pick, tags: right-click a branch in the branch popover to merge it into
  the current branch, rebase onto it, or delete it. Right-click a commit to cherry-pick it,
  create a branch or tag there, check it out, copy its hash, or push and delete its tags.
- Conflicts: a strip under the toolbar shows the merge, rebase or cherry-pick in progress with
  Continue and Abort. Conflicted files show the markers colored and offer "Keep ours", "Take
  theirs" and "Mark resolved".
- Credential prompts: when git or ssh asks for a username, password, passphrase or host-key
  confirmation, GitLite shows a sheet and passes the answer to git. Nothing is stored by GitLite;
  git's own credential helper does that as usual.
- Toolbar: branch pill with a popover to switch local or remote branches or create one, fetch, pull, push.
- Settings sheet: light or dark theme, accent color, relative or absolute dates, diff text size. Saved in the app.
- Draggable splitters between the middle column and the diff, and between graph and details.
- Window size, position and maximized state are remembered between starts.
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

- Interactive rebase, squash and reword.
- Submodules, worktrees and LFS.
- A built-in merge editor: conflicts are resolved by taking one side or editing the file
  elsewhere, then marking it resolved.
- Syntax colors are per line, so a comment or string that spans lines loses its color after
  the first line.

## License

GitLite is released under the [MIT License](LICENSE). It includes open-source software
from other projects; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Each build
ships both files. GitLite does not include git itself; it runs the git installed on the
computer.
