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
Plug 'lewis6991/gitsigns.nvim'

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

" Tree Sitter
Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}
Plug 'p00f/nvim-ts-rainbow'
Plug 'romgrk/nvim-treesitter-context'

" Verify Script
Plug 'mgrabovsky/vim-xverif'

" wasm
Plug 'rhysd/vim-wasm'

" fluent
Plug 'projectfluent/fluent.vim'

" pest
Plug 'pest-parser/pest.vim'

" == Language (semantic) ==
" ,jd	Jump Location (option)
" ,gd	Goto Definition
" C-j	Completion

" Language Client
Plug 'neovim/nvim-lspconfig'

Plug 'hrsh7th/cmp-nvim-lsp'
Plug 'hrsh7th/cmp-buffer'
Plug 'hrsh7th/cmp-path'
Plug 'hrsh7th/nvim-cmp'

" == Utils ==

" Plug 'vim-scripts/fcitx.vim'
Plug 'vim-scripts/DrawIt'
Plug 'fidian/hexmode'
Plug 'johngrib/vim-game-code-break'
" Plug 'ticki/rust-cute-vim'
" Plug 'wsdjeg/FlyGrep.vim'
Plug 'lambdalisue/suda.vim'

call plug#end()


lua <<EOF
require('gitsigns').setup {
  signs = {
    add          = {text = '+', },
    change       = {text = '~', },
    delete       = {text = '_', },
    topdelete    = {text = '_', },
    changedelete = {text = '~', },
  },
}

require'nvim-treesitter.configs'.setup {
  ensure_installed = { "rust", "json", "c", "cpp", "python", "javascript", "toml", "wgsl_bevy", "glsl", "ron", "typescript" },
  highlight = {
    enable = true,
  },
  rainbow = {
    enable = true
  }
}

require'treesitter-context'.setup{
    enable = true, -- Enable this plugin (Can be enabled/disabled later via commands)
}

vim.g.splitbelow = true

-- LSP settings
local nvim_lsp = require('lspconfig')
local on_attach = function(_client, bufnr)
  -- vim.api.nvim_buf_set_option(bufnr, 'omnifunc', 'v:lua.vim.lsp.omnifunc')

  local opts = { noremap=true, silent=true }
  vim.api.nvim_buf_set_keymap(bufnr, 'n', 'gD', '<Cmd>lua vim.lsp.buf.declaration()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', 'gd', '<Cmd>lua vim.lsp.buf.definition()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', 'K', '<Cmd>lua vim.lsp.buf.hover()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', 'gi', '<cmd>lua vim.lsp.buf.implementation()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<C-k>', '<cmd>lua vim.lsp.buf.signature_help()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>wa', '<cmd>lua vim.lsp.buf.add_workspace_folder()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>wr', '<cmd>lua vim.lsp.buf.remove_workspace_folder()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>wl', '<cmd>lua print(vim.inspect(vim.lsp.buf.list_workspace_folders()))<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>D', '<cmd>lua vim.lsp.buf.type_definition()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>rn', '<cmd>lua vim.lsp.buf.rename()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', 'gr', '<cmd>lua vim.lsp.buf.references()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>ca', '<cmd>lua vim.lsp.buf.code_action()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>e', '<cmd>lua vim.lsp.diagnostic.show_line_diagnostics()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', '[d', '<cmd>lua vim.lsp.diagnostic.goto_prev()<CR>', opts)
  vim.api.nvim_buf_set_keymap(bufnr, 'n', ']d', '<cmd>lua vim.lsp.diagnostic.goto_next()<CR>', opts)
  -- vim.api.nvim_buf_set_keymap(bufnr, 'n', '<leader>q', '<cmd>lua vim.lsp.diagnostic.set_loclist()<CR>', opts)
end

-- Enable the following language servers
local capabilities = require('cmp_nvim_lsp').default_capabilities()

local servers = { 'rust_analyzer' }
for _, lsp in ipairs(servers) do
  nvim_lsp[lsp].setup {
	on_attach = on_attach,
	autostart = false,
	capabilities = capabilities
  }
end

local cmp = require'cmp'

cmp.setup {
    mapping = cmp.mapping.preset.insert {
      ['<C-b>'] = cmp.mapping.scroll_docs(-4),
      ['<C-f>'] = cmp.mapping.scroll_docs(4),
      ['<C-o>'] = cmp.mapping.complete(),
      ['<C-e>'] = cmp.mapping.abort(),
      ['<CR>'] = cmp.mapping.confirm{ select = true },
    },
    sources = cmp.config.sources {
      { name = 'nvim_lsp' },
      { name = 'buffer' },
	  { name = 'path' },
    },
}

EOF

" == plugs config ==

colorscheme xcodewwdc
highlight GitSignsAdd		guifg=green
highlight GitSignsChange	guifg=yellow
highlight GitSignsDelete	guifg=red
