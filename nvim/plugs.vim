call plug#begin('~/.config/nvim/plugged')

" == Operation ==

Plug 'terryma/vim-multiple-cursors'
Plug 'kien/ctrlp.vim'

Plug 'airblade/vim-gitgutter'
let g:gitgutter_map_keys = 0

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
nnoremap <leader>py	:ConqueTermSplit ipython<CR>

Plug 'bronson/vim-trailing-whitespace'
map <leader><space>	:FixWhitespace<cr>
let g:extra_whitespace_ignored_filetypes = ['unite', 'mkd', 'conque_term']

Plug 'Raimondi/delimitMate'
au FileType python let b:delimitMate_nesting_quotes = ['"']

call plug#end()
