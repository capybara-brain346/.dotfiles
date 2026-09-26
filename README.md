# Laptop configuration backup (Linux)

This repository contains **copies**, not symlinks, of the configuration currently used on this laptop. The live files are not changed when you edit the copies here. The setup below assumes a Linux laptop, Bash, and a checkout at `~/code/.dotfiles`; adjust paths for another OS or username. Run the commands from a terminal on the **new** laptop, not the old one.

**Agent-assisted setup:** Open this repository with a coding agent and say: “Set up this laptop using `AGENTS.md` and `README.md`.” The agent should back up existing files, install available prerequisites, restore configs, validate them, and report any interactive steps it cannot complete. You can also say “Refresh this dotfiles backup from my live config” on the original laptop.

> **Before publishing:** an older commit in this repository contains an API key in the root `.zshrc`. The current copy has had the key removed, but deleting a line does not remove it from Git history. Revoke/rotate that key before making this repository public or treating it as a safe backup. Do not add credentials here. Review the entire history separately if you need it to be secret-free.

## What to restore

| Repository copy | Live location | Purpose |
| --- | --- | --- |
| `shell/.zshrc` | `~/.zshrc` | Oh My Zsh, aliases, tools and PATH (current version) |
| `shell/.bashrc` | `~/.bashrc` | Bash prompt, completion and PATH (current version) |
| `shell/.profile` | `~/.profile` | Login shell environment |
| `vim/.vimrc` | `~/.vimrc` | Vim configuration, separate from Neovim |
| `tmux/.tmux.conf` | `~/.tmux.conf` | tmux prefix, panes, status bar and TPM |
| `herdr/config.toml` | `~/.config/herdr/config.toml` | Herdr bindings and appearance |
| `nvim/` | `~/.config/nvim/` | Neovim's current Kickstart/vim.pack config and plugin lock |
| `pi/agent/settings.json` | `~/.pi/agent/settings.json` | Pi preferences and package declarations |
| `pi/agent/APPEND_SYSTEM.md` | `~/.pi/agent/APPEND_SYSTEM.md` | Pi global prompt addendum |
| `pi/agent/extensions/*.ts` | `~/.pi/agent/extensions/` | Active Pi extensions |
| `pi/agent/extensions-disabled/` | `~/.pi/agent/extensions-disabled/` | Inactive/experimental Pi extensions; **do not move into `extensions/`** |
| `pi/agent/themes/edgerunners.json` | `~/.pi/agent/themes/edgerunners.json` | Pi color theme |

Also present at the repo root are **older snapshots** (`.zshrc`, `.bashrc`, `.vimrc`, `.tmux.config`, `settings.json`, `keybindings.json`). Do **not** use these for the current setup. The two JSON files are historical VS Code User settings/keybindings; if wanted, inspect them and copy them to `~/.config/Code/User/` on Linux (VS Code locations differ on other platforms). The former root-level `lua/` and `nvim/after/`/`nvim/lua/capybara/` files belonged to older Neovim setups and are not dependencies of the current `nvim/init.lua`.

## 1. Install applications

Install Git, Zsh, tmux, Vim (optional), Neovim **0.12+**, Node.js **22.19+**, npm, `make`, and `ripgrep` using your OS package manager or official installers. Verify before restoring:

```sh
git --version
zsh --version
tmux -V
nvim --version | head -1
node --version
npm --version
rg --version | head -1
```

The Neovim config uses the built-in `vim.pack` plugin manager and modern LSP APIs; older versions of Neovim will not run it. `git` and network access are needed to fetch plugins; `make` builds Telescope's optional native finder and LuaSnip regex support. `rg` enables Telescope live grep. Install `lazygit` separately for `<Space>gg`; clipboard integration needs a working OS clipboard provider. Mason downloads LSP servers/formatters (Lua, TypeScript, Python, Prettier, Ruff); these are not committed. Some optional language parsers and binaries also install on first use.

For Pi (the `pi` command from **pi.dev**, not Python), install the CLI after installing Node:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

Pi can alternatively be installed using the official pi.dev installer. Install **Herdr** using its official distribution for your OS and confirm `herdr` is on `PATH`; the old laptop has its binary in `~/.local/bin/herdr`, but this repository does **not** contain the binary. There is no need to install Herdr to use tmux, or tmux to use Herdr. On this laptop both use `Ctrl-S` as their prefix; use one multiplexer at a time if those bindings collide when nested.

## 2. Clone and back up what the new laptop already has

```sh
mkdir -p "$HOME/code"
git clone https://github.com/capybara-brain346/.dotfiles.git "$HOME/code/.dotfiles"
repo="$HOME/code/.dotfiles"
backup="$HOME/dotfiles-before-restore-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
for item in .zshrc .bashrc .profile .vimrc .tmux.conf .config/herdr/config.toml .config/nvim .pi/agent/settings.json .pi/agent/APPEND_SYSTEM.md .pi/agent/extensions .pi/agent/extensions-disabled .pi/agent/themes/edgerunners.json; do
  if [ -e "$HOME/$item" ]; then
    mkdir -p "$backup/$(dirname "$item")"
    cp -a "$HOME/$item" "$backup/$item"
  fi
done
printf 'Existing configuration backed up in %s\n' "$backup"
```

If the repository was already cloned somewhere else, set `repo` to that absolute directory instead of cloning. Read any existing local configs before replacing them; the commands below overwrite same-named files, and will not migrate settings from the new laptop. The backup loop copies only the named items, not Pi credentials or Herdr sessions.

## 3. Restore shells and Vim

Install [Oh My Zsh](https://ohmyz.sh/) before using the copied `.zshrc` (it sources `$HOME/.oh-my-zsh/oh-my-zsh.sh`). Then:

```sh
repo="$HOME/code/.dotfiles"
cp "$repo/shell/.zshrc" "$HOME/.zshrc"
cp "$repo/shell/.bashrc" "$HOME/.bashrc"
cp "$repo/shell/.profile" "$HOME/.profile"
cp "$repo/vim/.vimrc" "$HOME/.vimrc"  # optional if you only use Neovim
zsh -n "$HOME/.zshrc"
bash -n "$HOME/.bashrc"
# Edit the machine-specific paths and unguarded source/brew calls below before running: exec zsh
```

The Zsh file assumes the `awesomepanda` Oh My Zsh theme, and defines `v` for Neovim, `hr` for Herdr, `cc` for Claude, `oc` for OpenCode, `cx` for Codex, `nvb` for vibe-kanban, and an SSH alias `rtx`. Those programs are **not** installed by this repo. `shell/.zshrc` is an **unchanged copy of the current laptop's `~/.zshrc`**, not a portable version. It references `/home/capybara/.bun/_bun`, `/home/capybara/.opencode/bin`, `/home/linuxbrew/.linuxbrew/bin/brew`, `CUDA_HOME=/usr`, and a private SSH/Tailscale address. It also sources `~/.local/bin/env` unconditionally. **Before `exec zsh` on a new machine, adjust/remove those machine-specific lines and guard the `env` source and Homebrew call if those tools are absent.** The Bash file assumes Ubuntu's `lesspipe`/bash-completion conventions and guards `~/.local/bin/env`; `.profile` adds JetBrains Toolbox scripts only when installed. `~/.profile` is read by login shells; log out/in to pick up login-time changes.

Do not copy tokens, `.env`, shell histories, SSH keys, or `~/.pi/agent/auth.json` into this repo. Reauthenticate each tool on the new laptop.

## 4. Restore tmux

```sh
repo="$HOME/code/.dotfiles"
cp "$repo/tmux/.tmux.conf" "$HOME/.tmux.conf"
mkdir -p "$HOME/.tmux/plugins"
git clone https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
tmux -f "$HOME/.tmux.conf" new -s work
```

If TPM is already installed, skip the `git clone`. In tmux, press **Ctrl-S then I** (capital `I`) to let TPM install `niksingh710/minimal-tmux-status`. The config uses `Ctrl-S` as prefix, `Ctrl-S` then `r` to reload, `Ctrl-S` then `b` to toggle the status bar, `Ctrl-S` then `g` for a tiled 2×2 layout, and mouse support. Plugins under `~/.tmux/plugins/` are third-party checkouts and deliberately not backed up here. If tmux reports unknown `extended-keys` options, upgrade tmux.

## 5. Restore Herdr

```sh
repo="$HOME/code/.dotfiles"
mkdir -p "$HOME/.config/herdr"
cp "$repo/herdr/config.toml" "$HOME/.config/herdr/config.toml"
herdr --help
```

Start Herdr normally after installation. The config uses `Ctrl-S` as prefix, `h/j/k/l` for pane focus, `v` and `-` for splits, `g` for a tiled layout, and a Gruvbox theme. Herdr's `session.json`, logs, sockets, `.plugins.lock`, and executable are runtime/generated data: they are **not** part of this backup. Herdr may reinstall/update its Pi integration (see next section).

## 6. Restore Neovim

```sh
repo="$HOME/code/.dotfiles"
# Start with a clean config: old Lua modules can conflict with the new init.lua.
if [ -d "$HOME/.config/nvim" ]; then
  mv "$HOME/.config/nvim" "$HOME/.config/nvim-before-restore-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$HOME/.config/nvim"
cp -R "$repo/nvim/." "$HOME/.config/nvim/"
nvim
```

On first start, `vim.pack` fetches the declared plugins; Mason then installs the listed tools. Run `:checkhealth`, `:Mason`, and `:lua vim.pack.update(nil, { offline = true })` inside Neovim if something is missing. `nvim/nvim-pack-lock.json` is a plugin snapshot; use `:lua vim.pack.update()` when you intentionally want to update. The source tree contains the active `init.lua`, its `lua/` directory (including optional Kickstart examples), and the lock file; it excludes the nested Kickstart Git checkout, upstream issue templates/docs, plugin caches, swap/undo data, and Mason binaries. `<Space>` is the leader; `<Space>sf` finds files, `<Space>sg` greps, `<Space>f` formats, and `<Space>gg` launches lazygit. To use the optional example plugins, uncomment their `require` lines near the end of `nvim/init.lua`.

## 7. Restore Pi

```sh
repo="$HOME/code/.dotfiles"
mkdir -p "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/extensions-disabled" "$HOME/.pi/agent/themes"
cp "$repo/pi/agent/settings.json" "$repo/pi/agent/APPEND_SYSTEM.md" "$HOME/.pi/agent/"
cp "$repo/pi/agent/themes/edgerunners.json" "$HOME/.pi/agent/themes/"
cp "$repo/pi/agent/extensions/"{accessible-statusline,terminal-art-header,herdr-prompts,plan-mode,rounded-editor}.ts "$HOME/.pi/agent/extensions/"
cp "$repo/pi/agent/extensions-disabled/"* "$HOME/.pi/agent/extensions-disabled/"
pi update --extensions
pi
```

In Pi run `/login` to connect your provider; **never copy `auth.json` into Git**. `settings.json` selects `edgerunners`, a preferred `openai-codex` model, and four Git/npm packages. If that model is unavailable on the new machine, pick one in `/model` or change `defaultModel` in `settings.json`. `pi update --extensions` fetches package declarations; network access is required. `/reload` applies changed settings/extensions after a Pi session is already running.

The Herdr-managed `herdr-agent-state.ts` is kept in `pi/agent/extensions/` as a **reference copy**, but the restore commands intentionally leave it out: let Herdr install its Pi integration so versions match. If Herdr is unavailable and you still want that exact version, copy it manually after checking compatibility. `herdr-prompts.ts` is only useful with the Herdr integration. Files in `extensions-disabled/` stay disabled; one configures tmux-backed subagents, another is a system monitor. The statusline extension uses the active Pi credential at runtime but no token is stored in the repo. Pi extensions run as your user; review them and the third-party packages before enabling. `defaultProjectTrust` is set to `always` in this snapshot: consider changing it to `ask` on a new laptop, particularly if you open untrusted repositories.

Do **not** back up `~/.pi/agent/auth.json`, `models-store.json`, `trust.json`, session transcripts, Pi's installed packages, `node_modules`, or generated caches in Git. Installed packages are reproducible from `settings.json`; custom extensions and theme are backed up above. If you have other personal Pi skills or prompts not in this repo, audit and add them individually after checking for secrets and licensing.

## Updating this backup later

Changes to live files do **not** automatically appear here. From the original laptop, copy the changed files into their corresponding repository paths, inspect `git diff` and `git status`, then commit and push **only after checking for credentials and rotating the historical API key**. Re-copy Neovim's `init.lua`, `lua/`, and lock file together when changing plugins. Never blindly `cp -R ~/.config/herdr`, `~/.pi`, or `~/.config/nvim` into Git: those contain sockets, logs, credentials, histories, package checkouts, or caches. On a new laptop, restore from the same Git revision as this README.
