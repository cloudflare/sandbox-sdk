export const COMMAND_SESSION_FRAME_PREFIX = '__SANDBOX_SESSIONS__';

export function createCommandSessionScript(tempDir: string): string {
  const safeTempDir = shellQuote(tempDir);
  return [
    'set +H',
    'shopt -s expand_aliases',
    'unset HISTFILE',
    'export HISTFILE=/dev/null',
    `__sandbox_sessions_dir=${safeTempDir}`,
    `__sandbox_sessions_frame() { printf '${COMMAND_SESSION_FRAME_PREFIX}|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5"; }`,
    '__sandbox_sessions_base64_file() {',
    '  base64 < "$1" | tr -d \'\\n\'',
    '}',
    '__sandbox_sessions_done() {',
    '  local exec_id="$1" exit_code="$2" stdout_file="$3" stderr_file="$4"',
    `  printf '${COMMAND_SESSION_FRAME_PREFIX}|DONE|%s|%s|' "$exec_id" "$exit_code"`,
    '  __sandbox_sessions_base64_file "$stdout_file"',
    "  printf '|'",
    '  __sandbox_sessions_base64_file "$stderr_file"',
    "  printf '\\n'",
    '}',
    '__sandbox_sessions_exec() {',
    '  local exec_id="$1" cmd_b64="$2" cmd stdout_file stderr_file exit_code',
    '  stdout_file="$__sandbox_sessions_dir/$exec_id.stdout"',
    '  stderr_file="$__sandbox_sessions_dir/$exec_id.stderr"',
    '  cmd=$(echo "$cmd_b64" | base64 -d 2>/dev/null) || { __sandbox_sessions_frame DONE "$exec_id" 1 "" "" ""; return; }',
    '  rm -f "$stdout_file" "$stderr_file"',
    '  : > "$stdout_file"',
    '  : > "$stderr_file"',
    '  {',
    '    eval "$cmd"',
    '    exit_code=$?',
    '  } < /dev/null > "$stdout_file" 2> "$stderr_file"',
    '  __sandbox_sessions_done "$exec_id" "$exit_code" "$stdout_file" "$stderr_file"',
    '  rm -f "$stdout_file" "$stderr_file"',
    '}',
    '__sandbox_sessions_frame READY session 0 "" ""',
    ''
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
