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

Plug 'lotabout/skim.vim'

" Similarly, we can apply it to fzf#vim#grep. To use ripgrep instead of ag:
command! -bang -nargs=* Rg
  \ call fzf#vim#grep(
  \   'rg --column --line-number --no-heading --color=always '.shellescape(<q-args>), 1,
  \   <bang>0 ? fzf#vim#with_preview('up:60%')
  \           : fzf#vim#with_preview('right:50%:hidden', '?'),
  \   <bang>0)

function! s:fzf_statusline()
  " Override statusline as you like
  highlight fzf1 ctermfg=161 ctermbg=251
  highlight fzf2 ctermfg=23 ctermbg=251
  highlight fzf3 ctermfg=237 ctermbg=251
  setlocal statusline=%#fzf1#\ >\ %#fzf2#fz%#fzf3#f
endfunction

autocmd! User FzfStatusLine call <SID>fzf_statusline()

" theme
Plug 'arzg/vim-colors-xcode'

Plug 'rhysd/vim-color-spring-night'

Plug 'wadackel/vim-dogrun'

Plug 'joshdick/onedark.vim'
let g:lightline = {
  \ 'colorscheme': 'onedark',
  \ }

" == Language highlight ==

" Rust
Plug 'rust-lang/rust.vim'
" Plug 'arzg/vim-rust-syntax-ext'

" fish
Plug 'dag/vim-fish'

" toml
Plug 'cespare/vim-toml'

" Verify Script
Plug 'mgrabovsky/vim-xverif'

" wasm
Plug 'rhysd/vim-wasm'

" fluent
Plug 'projectfluent/fluent.vim'

" pest
Plug 'pest-parser/pest.vim'

" markdown
" Plug 'gabrielelana/vim-markdown'
" let g:markdown_enable_mappings = 0
" let g:markdown_enable_insert_mode_mappings = 0
" let g:markdown_enable_spell_checking = 0
" let g:markdown_enable_input_abbreviations = 0
" let g:markdown_enable_conceal = 1

" Plug 'sheerun/vim-polyglot'

" == Language (semantic) ==
" ,jd	Jump Location (option)
" ,gd	Goto Definition
" C-j	Completion

" Language Client
Plug 'autozimu/LanguageClient-neovim', { 'do': ':UpdateRemotePlugins', 'branch': 'next' }
" (Completion plugin option 1)
Plug 'ncm2/ncm2'
" ncm2 requires nvim-yarp
Plug 'roxma/nvim-yarp'
Plug 'ncm2/ncm2-path'
Plug 'ncm2/float-preview.nvim'
" enable ncm2 for all buffers
autocmd BufEnter * call ncm2#enable_for_buffer()
let g:float_preview#docked = 0
let g:float_preview#auto_close = 0
" :help Ncm2PopupOpen for more information
set completefunc=LanguageClient#complete
set completeopt=noinsert,menuone,noselect
au FileType rust inoremap	<C-j>			<C-x><C-o>

" Required for operations modifying multiple buffers like rename.
set hidden
let g:LanguageClient_serverCommands = {
    \ 'rust': ['rust-analyzer' ],
    \ }
au FileType rust nnoremap <F5>					:call LanguageClient_contextMenu()<CR>
au FileType rust nnoremap <silent>K				:call LanguageClient_textDocument_hover()<CR>
au FileType rust nnoremap <silent><leader>gd	:split<CR>:call LanguageClient_textDocument_definition()<CR>
au FileType rust nnoremap <silent><leader>re	:call LanguageClient_textDocument_rename()<CR>
let g:LanguageClient_autoStart = 0
let g:LanguageClient_loggingFile =  expand('/tmp/LanguageClient.log')
let g:LanguageClient_serverStderr = expand('/tmp/LanguageServer.log')

" Rust
" Plug 'racer-rust/vim-racer'
" let g:racer_cmd = 'racer'
" let g:racer_experimental_completer = 1
" au FileType rust nmap		<leader>gd		:split<CR>:call racer#GoToDefinition()<CR>
" au FileType rust nmap		K				:call racer#ShowDocumentation()<CR>
" au FileType rust inoremap	<C-j>			<C-x><C-o>

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

" Plug 'vim-scripts/fcitx.vim'
Plug 'vim-scripts/DrawIt'
Plug 'fidian/hexmode'
Plug 'johngrib/vim-game-code-break'
" Plug 'ticki/rust-cute-vim'
" Plug 'wsdjeg/FlyGrep.vim'
Plug 'lambdalisue/suda.vim'


call plug#end()
