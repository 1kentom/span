# Source the same interactive startup file Bash normally loads.
if [[ -f "$HOME/.bashrc" ]]; then
  builtin source "$HOME/.bashrc"
fi
_span_prompt() {
  local _span_status=$?
  _span_prompt_cwd=${PWD##*/}
  [[ -n $_span_prompt_cwd ]] || _span_prompt_cwd=/
  _span_prompt_cwd=${_span_prompt_cwd//[[:cntrl:]]/?}
  _span_prompt_git=''
  local _span_branch
  if _span_branch=$(command git symbolic-ref --quiet --short HEAD 2>/dev/null); then
    _span_branch=${_span_branch//[[:cntrl:]]/?}
    _span_prompt_git=" git:($_span_branch)"
  fi
  # The prompt contains literal variable references. Values are not reparsed as
  # commands or as Bash prompt escapes.
  if shopt -q promptvars; then
    PS1='\[\e[32m\]→\[\e[0m\] ${_span_prompt_cwd}\[\e[36m\]${_span_prompt_git}\[\e[0m\] '
  else
    local _span_cwd=${_span_prompt_cwd//\\/\\\\}
    local _span_git=${_span_prompt_git//\\/\\\\}
    PS1="\[\e[32m\]→\[\e[0m\] $_span_cwd\[\e[36m\]$_span_git\[\e[0m\] "
  fi
  return "$_span_status"
}
# Bash 5 supports an array of prompt commands. Bash 3.2 uses one string.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=( _span_prompt )
  else
    # Older Bash executes only element zero. Keep its existing array semantics.
    PROMPT_COMMAND[0]="${PROMPT_COMMAND[0]-}"$'\n_span_prompt'
  fi
else
  PROMPT_COMMAND="${PROMPT_COMMAND-}"$'\n_span_prompt'
fi
_span_prompt
