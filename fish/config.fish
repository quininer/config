# Path to Oh My Fish install.
set -gx OMF_PATH "/home/quininer/.local/share/omf"

# Customize Oh My Fish configuration path.
#set -gx OMF_CONFIG "/home/quininer/.config/omf"

# Load oh-my-fish configuration.
source $OMF_PATH/init.fish

set -x PATH /usr/bin /home/quininer/.cargo/bin /home/quininer/.local/bin

# config
set -gx SSH_ASKPASS (which ksshaskpass)
set -gx EDITOR (which vi)
sh ~/.login.sh

fish_vi_key_bindings
fish_vi_cursor

set -x CHROOT $HOME/.cache/chroot

# alias ls
function ls
	exa $argv
end

# alias clip2vimcn
function clip2vimcn
	xclip -sel c -t image/png -o | curl -F "name=@-" "https://img.vim-cn.com/"
end
