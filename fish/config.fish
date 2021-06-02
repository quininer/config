fish_vi_key_bindings
fish_vi_cursor

set -x fish_cursor_insert	block

set -x PATH					$PATH $HOME/.local/bin $HOME/.cargo/bin
set -x EDITOR				nvim
set -x PAGER				less
set -x SSH_ASKPASS			(which ksshaskpass)
# set -x LD_LIBRARY_PATH		(rustc --print sysroot)/lib
# set -x RUSTUP_DIST_SERVER	"https://mirrors.ustc.edu.cn/rust-static"

alias wget	"curl -L -O -C -"
alias ls	exa
alias grep	rg
alias aa16	"aria2c -k1M -j16 -x16 -s16 --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "(chromium --version | string replace "Chromium " "Chrome/" | string trim -r --chars="Arch Linux")" Safari/537.36'"

# color man
set -x LESS_TERMCAP_md (printf "\e[01;31m")
set -x LESS_TERMCAP_me (printf "\e[0m")
set -x LESS_TERMCAP_se (printf "\e[0m")
set -x LESS_TERMCAP_so (printf "\e[01;44;33m")
set -x LESS_TERMCAP_ue (printf "\e[0m")
set -x LESS_TERMCAP_us (printf "\e[01;32m")

set -x CHROOT	$HOME/.cache/chroot
