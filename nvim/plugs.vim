call plug#begin('~/.config/nvim/plugged')

" == Plugin manager ==
Plug 'junegunn/vim-plug'


" == Operation (active) ==

" multiple cursors
Plug 'terryma/vim-multiple-cursors'

" file tree
Plug 'scrooloose/nerdtree'
map <leader>n :NERDTreeToggle<CR>
let NERDTreeHighlightCursorline=1
let g:NERDTreeMapOpenSplit = 's'
let g:NERDTreeMapOpenVSplit = 'v'

Plug 'Xuyuanp/nerdtree-git-plugin'


" buffer manager
Plug 'vim-ctrlspace/vim-ctrlspace'
let g:CtrlSpaceDefaultMappingKey = "<C-o>"
let g:airline_exclude_preview = 1

Plug 'simnalamburt/vim-mundo'
let g:mundo_prefer_python3 = 1
nnoremap <leader>h :MundoToggle<CR>

Plug 'wsdjeg/FlyGrep.vim'
nnoremap <leader>f :FlyGrep<cr>

" == Operation (passive) ==

" git diff hint
Plug 'airblade/vim-gitgutter'
let g:gitgutter_map_keys = 0

" trailing whitespace
Plug 'ntpeters/vim-better-whitespace'
map <leader><space>		:StripWhitespace<CR>
let g:better_whitespace_filetypes_blacklist=['mundo', 'mkd']


" auto brackets/quotes
Plug 'Raimondi/delimitMate'
au FileType python let b:delimitMate_nesting_quotes = ['"']


" == UI ==

" status bar
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'
let g:airline_theme="luna"

" brackets highlight
Plug 'kien/rainbow_parentheses.vim'
let g:rbpt_colorpairs = [
	\ ['brown',       'RoyalBlue3'],
	\ ['Darkblue',    'SeaGreen3'],
	\ ['darkgray',    'DarkOrchid3'],
	\ ['darkgreen',   'firebrick3'],
	\ ['darkcyan',    'RoyalBlue3'],
	\ ['darkred',     'SeaGreen3'],
	\ ['darkmagenta', 'DarkOrchid3'],
	\ ['brown',       'firebrick3'],
	\ ['gray',        'RoyalBlue3'],
	\ ['black',       'SeaGreen3'],
	\ ['darkmagenta', 'DarkOrchid3'],
	\ ['Darkblue',    'firebrick3'],
	\ ['darkgreen',   'RoyalBlue3'],
	\ ['darkcyan',    'SeaGreen3'],
	\ ['darkred',     'DarkOrchid3'],
	\ ['red',         'firebrick3'],
	\ ]
let g:rbpt_max = 40
let g:rbpt_loadcmd_toggle = 0
" au VimEnter * RainbowParenthesesToggle
" au Syntax * RainbowParenthesesLoadRound
" au Syntax * RainbowParenthesesLoadSquare
" au Syntax * RainbowParenthesesLoadBraces

" theme
Plug 'altercation/vim-colors-solarized'
let g:solarized_termcolors=256
let g:solarized_termtrans=1


" == Language highlight ==

" Rust
Plug 'rust-lang/rust.vim'

" fish
Plug 'dag/vim-fish'

" toml
Plug 'cespare/vim-toml'

" Verify Script
Plug 'mgrabovsky/vim-xverif'


" == Language (semantic) ==
" ,jd	Jump Location (option)
" ,gd	Goto Definition
" C-j	Completion

" Language Client
Plug 'autozimu/LanguageClient-neovim', { 'do': ':UpdateRemotePlugins' }
" (Optional) Showing function signature and inline doc.
Plug 'Shougo/echodoc.vim'
" (Optional) Completion integration with deoplete.
Plug 'Shougo/deoplete.nvim', { 'do': ':UpdateRemotePlugins' }
" let g:deoplete#enable_at_startup = 1
" let g:deoplete#enable_smart_case = 1
" let g:deoplete#disable_auto_complete = 1

" Required for operations modifying multiple buffers like rename.
set hidden
let g:LanguageClient_serverCommands = {
    \ 'rust': ['rls'],
    \ }
" au FileType rust nnoremap <silent>K				:call LanguageClient_textDocument_hover()<CR>
" au FileType rust nnoremap <silent><leader>gd	:split<CR>:call LanguageClient_textDocument_definition()<CR>
au FileType rust nnoremap <silent><leader>re	:call LanguageClient_textDocument_rename()<CR>
"au FileType rust inoremap <silent><expr><C-j>	<TAB>
""	\ pumvisible() ? "\<C-n>" :
""	\ <SID>check_back_space() ? "\<TAB>" :
""	\ deoplete#mappings#manual_complete()

function! s:check_back_space() abort "{{{
	let col = col('.') - 1
	return !col || getline('.')[col - 1]  =~ '\s'
endfunction"}}}
" au FileType rust LanguageClientStart

" Rust
Plug 'racer-rust/vim-racer'
let g:racer_cmd = 'racer'
let g:racer_experimental_completer = 1
au FileType rust nmap		<leader>gd		:split<CR>:call racer#GoToDefinition()<CR>
au FileType rust nmap		K				:call racer#ShowDocumentation()<CR>
au FileType rust inoremap	<C-j>			<C-x><C-o>

" Python
Plug 'mathieui/pyflakes3-vim'
let g:pyflakes_use_quickfix = 0

" Python
Plug 'davidhalter/jedi-vim'
let g:jedi#use_splits_not_buffers = 'top'
let g:jedi#popup_on_dot = 1
let g:jedi#popup_select_first = 1
let g:jedi#goto_assignments_command = '<leader>jd'
let g:jedi#goto_definitions_command = '<leader>gd'
let g:jedi#documentation_command = 'K'
let g:jedi#usages_command = '<leader>u'
let g:jedi#completions_command = '<C-j>'
let g:jedi#rename_command = '<leader>r'
let g:jedi#force_py_version = 3
autocmd FileType python setlocal completeopt-=preview

" Markdown
" function! BuildComposer(info)
" "  if a:info.status != 'unchanged' || a:info.force
" "    !cargo build --release
" "    UpdateRemotePlugins
" "  endif
" endfunction
"
" Plug 'euclio/vim-markdown-composer', { 'do': function('BuildComposer') }

" == Utils ==

Plug 'vim-scripts/fcitx.vim'
Plug 'vim-scripts/DrawIt'
Plug 'fidian/hexmode'
Plug 'johngrib/vim-game-code-break'
" Plug 'ticki/rust-cute-vim'

call plug#end()
