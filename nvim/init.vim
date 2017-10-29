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


" == Plugins ==

" load vimfiles
set rtp^=/usr/share/vim/vimfiles/

if filereadable(expand('~/.config/nvim/plugs.vim'))
	source ~/.config/nvim/plugs.vim
endif


" == key ==

" jump
nnoremap k  gk
nnoremap gk k
nnoremap j  gj
nnoremap gj j

" long undo
nnoremap U <C-r>
" sudo write
cmap www w !sudo tee >/dev/null %
" quick quit
nnoremap <leader>q	:q<CR>
" quick esc
inoremap kj <ESC>
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

set background=dark
colorscheme solarized
set t_Co=256


" == utils ==

" set tab
autocmd FileType python set tabstop=4 shiftwidth=4 expandtab ai

" use clipboard
set clipboard+=unnamedplus

" mutt
au BufRead /tmp/mutt-* set tw=72

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
