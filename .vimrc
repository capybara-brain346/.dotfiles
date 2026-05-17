" ==========================================
" UI & Appearance
" ==========================================
" Enable hybrid line numbers
set number
set relativenumber

" Enable syntax highlighting
syntax on

" Set dark background and enable true colors
set background=dark
if has('termguicolors')
    set termguicolors
endif

" Manually set colors to mimic Anysphere dark theme
highlight Normal       guibg=#1c1c1c guifg=#e0e0e0
highlight Comment      guifg=#5f875f gui=italic
highlight Constant     guifg=#d78700
highlight Identifier   guifg=#af87ff
highlight Statement    guifg=#87afaf
highlight PreProc      guifg=#d7af5f
highlight Type         guifg=#5fafaf
highlight Special      guifg=#d75f87
highlight Underlined   guifg=#d75f87 gui=underline
highlight Error        guibg=#5f0000 guifg=#ffffff
highlight Visual       guibg=#333333
highlight LineNr       guifg=#5f5f5f
highlight CursorLineNr guifg=#af87ff
highlight MatchParen   guibg=#262626 guifg=#d78700

" Enable mouse support
set mouse=a


" ==========================================
" Tabs & Indentation
" ==========================================
set tabstop=4         " Number of spaces a <Tab> counts for
set shiftwidth=4      " Number of spaces for each indentation level
set softtabstop=4     " Number of spaces a <Tab> counts for while editing
set expandtab         " Use spaces instead of tabs
set autoindent        " Copy indent from current line when starting a new line


" ==========================================
" Search Settings
" ==========================================
set hlsearch          " Highlight all search matches
set incsearch         " Show match as search pattern is typed
set ignorecase        " Case-insensitive search
set smartcase         " Case-sensitive search if uppercase letters are used


" ==========================================
" Backups & System
" ==========================================
set encoding=utf-8    " Set default encoding to UTF-8
set noswapfile        " Disable swap file creation
set nobackup          " Disable backup file creation
set nowritebackup     " Disable backup file during writing


" ==========================================
" Key Mappings
" ==========================================
" Press Space to enter Command Mode
nnoremap <space> :
vnoremap <space> :

" Move current line up or down with Alt + Up / Alt + Down (normal mode)
nnoremap <A-Up>   :m .-2<CR>==
nnoremap <A-Down> :m .+1<CR>==

" Move selected lines up or down with Alt + Up / Alt + Down (visual mode)
vnoremap <A-Up>   :m '<-2<CR>gv=gv
vnoremap <A-Down> :m '>+1<CR>gv=gv
