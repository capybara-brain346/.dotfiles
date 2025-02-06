alias ga="git add"
alias gc="git commit -m"
alias gp="git push"
alias gs="git status"
alias la="ls -la"
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

# docker config
alias doc="docker"

# java config
alias jc="javac"
alias j="java"
alias jj="java -jar"

PS1='\[\e[32m\]\u@\h\[\e[33m\] \w\[\e[31m\]$(__git_ps1 " (%s)")\[\e[0m\] \$ '
