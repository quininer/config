" == Option ==

let mapleader = ','
let g:mapleader = ','

syntax on

set encoding=utf-8
set hidden
set nocompatible
set autoread
set shortmess=atI
set mouse-=a
set ruler
set number
set nowrap
set scrolloff=7
set showcmd
set showmode
set cursorcolumn
set cursorline
set hlsearch
set incsearch
set ignorecase
set smartindent
set autoindent
set tabstop=4
set shiftwidth=4
set softtabstop=4
set smarttab
set formatoptions+=m
set formatoptions+=B

set relativenumber number
au FocusLost * :set norelativenumber number
au FocusGained * :set relativenumber
autocmd InsertEnter * :set norelativenumber number
autocmd InsertLeave * :set relativenumber

filetype on
filetype plugin on

set history=2048
set backup
set backupdir=/tmp/vimbk/
if has('persistent_undo')
	set undolevels=1000
	set undoreload=10000
	set undofile
	set undodir=/tmp/vimundo/
endif

" == Plugins ==

call plug#begin('~/.config/nvim/plugged')

Plug 'terryma/vim-multiple-cursors'
Plug 'kien/ctrlp.vim'
" Plug 'airblade/vim-gitgutter'

" Plug 'sjl/gundo.vim'
" nnoremap <leader>h :GundoToggle<CR>

Plug 'bling/vim-airline'
Plug 'kien/rainbow_parentheses.vim'

Plug 'altercation/vim-colors-solarized'
let g:solarized_termcolors=256
let g:solarized_termtrans=1
let g:solarized_contrast="normal"
let g:solarized_visibility="normal"

Plug 'scrooloose/nerdtree'
map <leader>n :NERDTreeToggle<CR>
let NERDTreeHighlightCursorline=1
let g:NERDTreeMapOpenSplit = 's'
let g:NERDTreeMapOpenVSplit = 'v'

Plug 'vim-ctrlspace/vim-ctrlspace'
let g:CtrlSpaceDefaultMappingKey = "<C-o>"
let g:airline_exclude_preview = 1

Plug 'oplatek/Conque-Shell'
nnoremap <leader>sh	:ConqueTermSplit bash<CR>

Plug 'bronson/vim-trailing-whitespace'
map <leader><space>	:FixWhitespace<cr>

call plug#end()


" == key ==

nnoremap k  gk
nnoremap gk k
nnoremap j  gj
nnoremap gj j

inoremap <A-space> <ESC>

function! HideNumber()
    if(&relativenumber == &number)
        set relativenumber! number!
    elseif(&number)
        set number!
    else
        set relativenumber!
    endif
    set number?
endfunc
nnoremap <F2>	:call HideNumber()<CR>

map <A-j>	<C-W>j
map <A-k>	<C-W>k
map <A-h>	<C-W>h
map <A-l>	<C-W>l

nnoremap ;	:
noremap <silent><leader>/	:nohls<CR>

nnoremap <C-t>	:tabnew<CR>
inoremap <C-t>	<Esc>:tabnew<CR>
noremap <left>	:bp<CR>
noremap <right>	:bn<CR>

nmap w=	:resize +3<CR>
nmap w-	:resize -3<CR>
nmap w[	:vertical resize -3<CR>
nmap w]	:vertical resize +3<CR>

nnoremap <leader>q	:q<CR>

cmap www w !sudo tee >/dev/null %


" == UI ==

set background=dark
colorscheme solarized
set t_Co=256


" == utils ==

set clipboard=unnamed
