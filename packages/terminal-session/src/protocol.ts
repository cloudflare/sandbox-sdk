// biome-ignore-all lint/style/useTemplate: Bash parameter expansion strings are assembled from pieces because this file generates bash source.
const COMMAND_FD = 4;
const MARKER_PREFIX = '\x1b]777;terminal-session|';
const MARKER_SUFFIX = '\x07';
const BASH_EXPANSION_START = '$' + '{';
const MAX_MARKER_BODY_LENGTH = 1024;

export type ProtocolFrame = {
  type: 'READY' | 'EXEC_DONE';
  id: string;
  payload: string;
};

export type ProtocolEvent =
  | { kind: 'text'; value: string }
  | { kind: 'frame'; frame: ProtocolFrame };

export function createRcFileContent(): string {
  return [
    'set +H',
    'unset HISTFILE',
    'export HISTFILE=/dev/null',
    "export PS1='terminal-session$ '",
    '',
    '__terminal_session_nonce="' +
      BASH_EXPANSION_START +
      'TERMINAL_SESSION_NONCE}"',
    '__terminal_session_cmd_fd=' +
      BASH_EXPANSION_START +
      'TERMINAL_SESSION_CMD_FD:-4}',
    'if [[ -n "' +
      BASH_EXPANSION_START +
      'TERMINAL_SESSION_CMD_FIFO:-}" ]]; then',
    `  exec ${COMMAND_FD}<>"$TERMINAL_SESSION_CMD_FIFO"`,
    'fi',
    '',
    '__terminal_session_marker() {',
    '  printf \'\\033]777;terminal-session|%s|%s|%s|%s\\007\' "$__terminal_session_nonce" "$1" "$2" "$3"',
    '}',
    '',
    '__terminal_session_ready() { __terminal_session_marker READY "" ""; }',
    '__terminal_session_exec_done() { __terminal_session_marker EXEC_DONE "$1" "$2"; }',
    '',
    '__terminal_session_poll_exec() {',
    '  local line exec_id cmd_b64 cmd exit_code',
    '  local did_exec=0',
    '  while IFS= read -r -t 0.05 -u $__terminal_session_cmd_fd line 2>/dev/null; do',
    '    exec_id="' + BASH_EXPANSION_START + 'line%%|*}"',
    '    cmd_b64="' + BASH_EXPANSION_START + 'line#*|}"',
    '    cmd=$(echo "$cmd_b64" | base64 -d 2>/dev/null) || continue',
    '',
    '    printf \'%s\\n\' "$cmd"',
    '    eval "$cmd"',
    '    exit_code=$?',
    '    __terminal_session_exec_done "$exec_id" "$exit_code"',
    '    did_exec=1',
    '  done',
    '  [[ "$did_exec" == "1" ]]',
    '}',
    '',
    '__terminal_session_polling=0',
    '__terminal_session_poll_prompt() {',
    '  local saved_status=$?',
    '  if [[ "$__terminal_session_polling" == "1" ]]; then return $saved_status; fi',
    '  __terminal_session_polling=1',
    '  __terminal_session_poll_exec',
    '  __terminal_session_polling=0',
    '  return $saved_status',
    '}',
    '',
    '__terminal_session_poll_signal() {',
    '  local saved_status=$?',
    '  if [[ "$__terminal_session_polling" == "1" ]]; then return $saved_status; fi',
    '  __terminal_session_polling=1',
    '  if __terminal_session_poll_exec; then',
    "    printf '%s' \"" + BASH_EXPANSION_START + 'PS1@P}"',
    '  fi',
    '  __terminal_session_polling=0',
    '  return $saved_status',
    '}',
    '',
    "trap '__terminal_session_poll_signal' WINCH",
    'PROMPT_COMMAND="__terminal_session_poll_prompt"',
    '',
    '__terminal_session_ready',
    ''
  ].join('\n');
}

export function parseTerminalChunk(options: {
  buffered: string;
  chunk: string;
  nonce: string;
}): { events: ProtocolEvent[]; buffered: string } {
  let input = options.buffered + options.chunk;
  const events: ProtocolEvent[] = [];

  while (true) {
    const markerStart = input.indexOf(MARKER_PREFIX);
    if (markerStart < 0) {
      const partialStart = findPartialMarkerStart(input);
      if (partialStart < 0) {
        pushText(events, input);
        input = '';
      } else {
        pushText(events, input.slice(0, partialStart));
        input = input.slice(partialStart);
      }
      break;
    }

    pushText(events, input.slice(0, markerStart));
    const markerBodyStart = markerStart + MARKER_PREFIX.length;
    const markerEnd = input.indexOf(MARKER_SUFFIX, markerBodyStart);
    const invalidNewline = findFirstNewline(input, markerBodyStart);

    if (invalidNewline >= 0 && (markerEnd < 0 || invalidNewline < markerEnd)) {
      pushText(events, input.slice(markerStart, invalidNewline + 1));
      input = input.slice(invalidNewline + 1);
      continue;
    }

    if (markerEnd < 0) {
      if (input.length - markerBodyStart <= MAX_MARKER_BODY_LENGTH) {
        input = input.slice(markerStart);
        break;
      }
      pushText(events, input.slice(markerStart, markerStart + 1));
      input = input.slice(markerStart + 1);
      continue;
    }

    if (markerEnd - markerBodyStart > MAX_MARKER_BODY_LENGTH) {
      pushText(events, input.slice(markerStart, markerStart + 1));
      input = input.slice(markerStart + 1);
      continue;
    }

    const marker = input.slice(markerBodyStart, markerEnd);
    const frame = parseMarker(marker, options.nonce);
    if (frame) {
      events.push({ kind: 'frame', frame });
    } else {
      pushText(
        events,
        input.slice(markerStart, markerEnd + MARKER_SUFFIX.length)
      );
    }
    input = input.slice(markerEnd + MARKER_SUFFIX.length);
  }

  return { events, buffered: input };
}

function pushText(events: ProtocolEvent[], value: string): void {
  if (value === '') {
    return;
  }
  const last = events.at(-1);
  if (last?.kind === 'text') {
    last.value += value;
    return;
  }
  events.push({ kind: 'text', value });
}

function findFirstNewline(input: string, start: number): number {
  const lineFeed = input.indexOf('\n', start);
  const carriageReturn = input.indexOf('\r', start);
  if (lineFeed < 0) {
    return carriageReturn;
  }
  if (carriageReturn < 0) {
    return lineFeed;
  }
  return Math.min(lineFeed, carriageReturn);
}

function parseMarker(marker: string, nonce: string): ProtocolFrame | null {
  const [markerNonce, type, id, payload] = marker.split('|');
  if (markerNonce !== nonce) {
    return null;
  }
  if (type !== 'READY' && type !== 'EXEC_DONE') {
    return null;
  }
  return { type, id: id ?? '', payload: payload ?? '' };
}

function findPartialMarkerStart(input: string): number {
  const maxLength = Math.min(input.length, MARKER_PREFIX.length - 1);
  for (let length = maxLength; length > 0; length--) {
    const start = input.length - length;
    if (MARKER_PREFIX.startsWith(input.slice(start))) {
      return start;
    }
  }
  return -1;
}
