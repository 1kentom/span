# This file runs after the user's startup configuration. Only prompt display is
# managed here. Existing aliases, completion definitions, options, and hooks stay.
_span_prompt_escape() {
  typeset -g _span_prompt_escaped=${1//[[:cntrl:]]/?}
  if [[ -o promptpercent ]]; then
    _span_prompt_escaped=${_span_prompt_escaped//\%/%%}
  fi
  if [[ -o promptbang ]]; then
    _span_prompt_escaped=${_span_prompt_escaped//!/!!}
  fi
  if [[ -o promptsubst ]]; then
    _span_prompt_escaped=${_span_prompt_escaped//\\/\\\\}
    _span_prompt_escaped=${_span_prompt_escaped//\$/\\$}
    _span_prompt_escaped=${_span_prompt_escaped//\`/\\\`}
  fi
}
_span_prompt() {
  local _span_status=$?
  local _span_cwd _span_git='' _span_branch
  _span_prompt_escape "${PWD:t}"
  _span_cwd=$_span_prompt_escaped
  if _span_branch=$(command git symbolic-ref --quiet --short HEAD 2>/dev/null); then
    _span_prompt_escape "$_span_branch"
    _span_git=" git:($_span_prompt_escaped)"
  fi
  # Data is escaped for the user's existing prompt options. Neither filenames nor
  # branch names can become commands, prompt directives, or terminal controls.
  if [[ -o promptpercent ]]; then
    typeset -g _span_managed_prompt="%F{green}→%f $_span_cwd%F{cyan}$_span_git%f "
  else
    typeset -g _span_managed_prompt="→ $_span_cwd$_span_git "
  fi
  PROMPT=$_span_managed_prompt
  RPROMPT=''
  # Prompt themes may move their own hook to the end. Preserve their order and
  # move this display override back after them for the following prompt.
  precmd_functions=( "${(@)precmd_functions:#_span_prompt}" _span_prompt )
  return 0
}
precmd_functions+=( _span_prompt )
# Async themes can update PROMPT while ZLE is active. Restore the cached
# compact prompt before drawing, while preserving existing widgets and hooks.
_span_restore_prompt() {
  if [[ -n ${_span_managed_prompt-} && ( $PROMPT != $_span_managed_prompt || -n ${RPROMPT-} ) ]]; then
    PROMPT=$_span_managed_prompt
    RPROMPT=''
    zle .reset-prompt
  fi
}
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-pre-redraw _span_restore_prompt
