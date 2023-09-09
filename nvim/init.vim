" == Option ==

let mapleader = ','
let g:mapleader = ','

if &shell =~# 'fish$'
    set shell=bash
endif

syntax on
set nocompatible
set encoding=utf-8
set history=2048
set hidden
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
set viminfo^=%
set guicursor=

" relative line number
set relativenumber number
au FocusLost * :set norelativenumber number
au FocusGained * :set relativenumber
autocmd InsertEnter * :set norelativenumber number
autocmd InsertLeave * :set relativenumber

filetype on
filetype indent on
filetype plugin on
filetype plugin indent on

" backup & undofile
set history=2048
set backup
set backupext=.bak
set backupdir=~/.cache/vimbk/
if has('persistent_undo')
	set undolevels=1000
	set undoreload=10000
	set undofile
	set undodir=~/.cache/vimundo/
endif

" auto viminfo
if has("autocmd")
  au BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") | exe "normal! g'\"" | endif
endif

" backspace move
set backspace=eol,start,indent
set whichwrap+=<,>,h,l


" == key ==

" jump
nnoremap k  gk
nnoremap gk k
nnoremap j  gj
nnoremap gj j

" long undo
nnoremap U <C-r>
" sudo write
cmap www w suda://%
" quick quit
nnoremap <leader>q	:q<CR>
" quick esc
inoremap <A-space> <ESC>
" quick command
nnoremap ;	:
" nohls
noremap <silent><leader>/	:nohls<CR>

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
" <F2> hide line number
nnoremap <F2>	:call HideNumber()<CR>
" <F3> ..
nnoremap <F3>	:set list! list?<CR>
" <F4> wrap newline
nnoremap <F4>	:set wrap! wrap?<CR>
" <F5> paste mode
set pastetoggle=<F5>
au InsertLeave * set nopaste

" window move
map <A-j>	<C-W>j
map <A-k>	<C-W>k
map <A-h>	<C-W>h
map <A-l>	<C-W>l

" window size
nmap w=	:resize +3<CR>
nmap w-	:resize -3<CR>
nmap w[	:vertical resize -3<CR>
nmap w]	:vertical resize +3<CR>

" tab & buffer
nnoremap <C-t>	:tabnew<CR>
inoremap <C-t>	<Esc>:tabnew<CR>
map <A-[>		:tabnext<cr>
map <A-]>		:tabprev<cr>
" nnoremap <A-[>	:bprevious<cr>
" nnoremap <A-]>	:bnext<cr>
noremap <left>	:bp<CR>
noremap <right>	:bn<CR>

" terminal
map <leader>s	:terminal fish<CR>
tnoremap <A-space> <C-\><C-n>


" == UI ==

"Use 24-bit (true-color) mode in Vim/Neovim when outside tmux.
"If you're using tmux version 2.2 or later, you can remove the outermost $TMUX check and use tmux's 24-bit color support
"(see < http://sunaku.github.io/tmux-24bit-color.html#usage > for more information.)
if (empty($TMUX))
  if (has("nvim"))
    "For Neovim 0.1.3 and 0.1.4 < https://github.com/neovim/neovim/pull/2198 >
    let $NVIM_TUI_ENABLE_TRUE_COLOR=1
  endif
  "For Neovim > 0.1.5 and Vim > patch 7.4.1799 < https://github.com/vim/vim/commit/61be73bb0f965a895bfb064ea3e55476ac175162 >
  "Based on Vim patch 7.4.1770 (`guicolors` option) < https://github.com/vim/vim/commit/8a633e3427b47286869aa4b96f2bfc1fe65b25cd >
  " < https://github.com/neovim/neovim/wiki/Following-HEAD#20160511 >
  if (has("termguicolors"))
    set termguicolors
  endif
endif

set background=dark
" set t_Co=256

" == Plugins ==

" load vimfiles
set rtp^=/usr/share/vim/vimfiles/

if filereadable(expand('~/.config/nvim/plugs.vim'))
	source ~/.config/nvim/plugs.vim
endif

" == Utils ==

" set tab
autocmd FileType python set tabstop=4 shiftwidth=4 expandtab ai

" use clipboard
set clipboard+=unnamedplus

" ydcv
" translate the word under cursor
function! SearchWord()
	echo system('ydcv --', expand("<cword>"))
endfunction
" translate selected text
function! SearchWord_v(type, ...)
	let sel_save = &selection
	let &selection = "inclusive"
	let reg_save = @@
	if a:0
		silent exe "normal! `<" . a:type . "`>y"
	elseif a:type == 'line'
		silent exe "normal! '[V']y"
	elseif a:type == 'block'
		silent exe "normal! `[\<C-V>`]y"
	else
		silent exe "normal! `[v`]y"
	endif
	echo system('ydcv --', @@)
	let &selection = sel_save
	let @@ = reg_save
endfunction
nnoremap <Leader>a :call SearchWord()<CR>
vnoremap <Leader>a :<C-U>call SearchWord_v(visualmode(), 1)<cr>

" justfile
augroup filetypedetect
  au BufNewFile,BufRead justfile setf make
  au BufNewFile,BufRead Justfile setf make
augroup END

" wgsl
augroup filetypedetect
  au BufNewFile,BufRead *.wgsl setf wgsl_bevy
augroup END
