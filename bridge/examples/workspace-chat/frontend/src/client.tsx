import { useChat } from '@ai-sdk/react';
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Surface,
  Text,
  Toasty,
  useKumoToastManager
} from '@cloudflare/kumo';
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  BrowserIcon,
  CaretRightIcon,
  CheckIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GearIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TerminalIcon,
  TrashIcon,
  XCircleIcon
} from '@phosphor-icons/react';
import { code } from '@streamdown/code';
import type { UIMessage } from 'ai';
import { getToolName, isToolUIPart } from 'ai';
import {
  forwardRef,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import { Streamdown } from 'streamdown';

// ---------------------------------------------------------------------------
// JSON syntax highlighting
// ---------------------------------------------------------------------------

type JsonToken = {
  type: 'key' | 'string' | 'number' | 'bool' | 'null' | 'punct';
  text: string;
};

function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const re =
    /("(?:[^"\\]|\\.)*")\s*:|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}[\]:,]/g;
  let match: RegExpExecArray | null = re.exec(json);
  let last = 0;
  while (match !== null) {
    if (match.index > last) {
      tokens.push({ type: 'punct', text: json.slice(last, match.index) });
    }
    const t = match[0];
    if (match[1]) {
      tokens.push({ type: 'key', text: match[1] });
      tokens.push({ type: 'punct', text: t.slice(match[1].length) });
    } else if (t.startsWith('"')) {
      tokens.push({ type: 'string', text: t });
    } else if (t === 'true' || t === 'false') {
      tokens.push({ type: 'bool', text: t });
    } else if (t === 'null') {
      tokens.push({ type: 'null', text: t });
    } else if (/^-?\d/.test(t)) {
      tokens.push({ type: 'number', text: t });
    } else {
      tokens.push({ type: 'punct', text: t });
    }
    last = match.index + t.length;
    match = re.exec(json);
  }
  if (last < json.length) {
    tokens.push({ type: 'punct', text: json.slice(last) });
  }
  return tokens;
}

const tokenColors: Record<JsonToken['type'], string> = {
  key: 'text-kumo-default font-medium',
  string: 'text-kumo-success',
  number: 'text-kumo-warning',
  bool: 'text-kumo-info',
  null: 'text-kumo-inactive',
  punct: 'text-kumo-subtle'
};

function HighlightedJson({ value }: { value: string }) {
  const tokens = tokenizeJson(value);
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
      {tokens.map((tok, i) => (
        <span key={`${tok.type}-${i}`} className={tokenColors[tok.type]}>
          {tok.text}
        </span>
      ))}
    </pre>
  );
}

function ToolDetail({
  label,
  children,
  open: controlledOpen,
  onToggle
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-kumo-elevated/50 transition-colors"
      >
        <CaretRightIcon
          size={12}
          weight="bold"
          className={`text-kumo-inactive shrink-0 transition-transform duration-150 ${controlledOpen ? 'rotate-90' : ''}`}
        />
        {label}
      </button>
      {controlledOpen && <div>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HTML artifact preview
// ---------------------------------------------------------------------------

/** Extract /artifacts/workspace/...*.html paths from markdown text. */
function extractHtmlArtifacts(text: string): string[] {
  const re = /\/artifacts\/workspace\/[^\s)"']+\.html?/gi;
  const matches = text.match(re);
  if (!matches) return [];
  // Deduplicate
  return [...new Set(matches)];
}

function HtmlPreview({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  const filename = src.split('/').pop() ?? src;

  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden my-2">
      <div className="flex items-center justify-between px-3 py-2 border-b border-kumo-line bg-kumo-elevated">
        <div className="flex items-center gap-2 min-w-0">
          <BrowserIcon size={14} className="text-kumo-accent shrink-0" />
          <span className="text-xs font-mono text-kumo-default truncate">
            {filename}
          </span>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="text-kumo-inactive hover:text-kumo-default transition-colors p-1 rounded hover:bg-kumo-base"
          title="Open in new tab"
        >
          <ArrowSquareOutIcon size={14} />
        </a>
      </div>
      <div className="relative bg-white" style={{ minHeight: 200 }}>
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Text size="xs" variant="secondary">
              Loading preview…
            </Text>
          </div>
        )}
        <iframe
          src={src}
          sandbox="allow-scripts allow-same-origin"
          className="w-full border-0"
          style={{ height: 400 }}
          title={`Preview of ${filename}`}
          onLoad={() => setLoaded(true)}
        />
      </div>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileEntry = {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  path: string;
};

type WorkspaceInfo = {
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
};

// ---------------------------------------------------------------------------
// File Browser (recursive tree)
// ---------------------------------------------------------------------------

type TreeNode = {
  name: string;
  path: string;
  size?: number;
  children?: TreeNode[];
};

function buildTree(files: { path: string; size: number }[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '/', children: [] };
  for (const file of files) {
    const parts = file.path.replace(/^\//, '').split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      if (!node.children) node.children = [];
      const existing = node.children.find((c) => c.name === parts[i]);
      if (i === parts.length - 1) {
        // leaf file
        if (!existing) {
          node.children.push({
            name: parts[i],
            path: file.path,
            size: file.size
          });
        }
      } else {
        // directory
        if (existing) {
          node = existing;
        } else {
          const dir: TreeNode = {
            name: parts[i],
            path: `/${parts.slice(0, i + 1).join('/')}`,
            children: []
          };
          node.children.push(dir);
          node = dir;
        }
      }
    }
  }
  // Sort: directories first, then files, alphabetical
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = a.children ? 0 : 1;
      const bDir = b.children ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sortNodes(n.children);
  };
  if (root.children) sortNodes(root.children);
  return root.children ?? [];
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const isDir = !!node.children;
  const isSelected = node.path === selectedPath;
  const pl = 12 + depth * 16;

  if (isDir) {
    return (
      <div>
        <div
          className="w-full py-1 flex items-center gap-1.5 text-left cursor-default"
          style={{ paddingLeft: pl }}
        >
          <FolderIcon size={14} className="text-kumo-accent shrink-0" />
          <span className="text-xs text-kumo-default truncate">
            {node.name}
          </span>
        </div>
        {node.children!.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={`w-full py-1 flex items-center gap-1.5 hover:bg-kumo-elevated text-left ${
        isSelected ? 'bg-kumo-elevated' : ''
      }`}
      style={{ paddingLeft: pl }}
    >
      <FileIcon size={14} className="text-kumo-subtle shrink-0" />
      <span className="text-xs text-kumo-default truncate flex-1">
        {node.name}
      </span>
      {node.size !== undefined && (
        <span className="text-[10px] text-kumo-inactive shrink-0 pr-3">
          {node.size > 1024
            ? `${(node.size / 1024).toFixed(1)}K`
            : `${node.size}B`}
        </span>
      )}
    </button>
  );
}

type FileBrowserHandle = { refresh: (opts?: { silent?: boolean }) => void };

const FileBrowser = forwardRef<FileBrowserHandle, {}>(
  function FileBrowser(_props, ref) {
    const [tree, setTree] = useState<TreeNode[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedFile, setSelectedFile] = useState<{
      path: string;
      content: string;
    } | null>(null);
    const [info, setInfo] = useState<WorkspaceInfo | null>(null);

    const loadTree = useCallback(async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const res = await fetch('/api/files-tree');
        if (res.ok) {
          const files = await res.json();
          setTree(buildTree(files));
        } else {
          setTree([]);
        }
      } catch {
        setTree([]);
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    }, []);

    const loadInfo = useCallback(async () => {
      try {
        const res = await fetch('/api/workspace/info');
        if (res.ok) {
          setInfo(await res.json());
        }
      } catch {
        // ignore
      }
    }, []);

    useEffect(() => {
      loadTree();
      loadInfo();
    }, [loadTree, loadInfo]);

    const refresh = useCallback(
      (opts?: { silent?: boolean }) => {
        loadTree(opts);
        loadInfo();
      },
      [loadTree, loadInfo]
    );

    useImperativeHandle(ref, () => ({ refresh }), [refresh]);

    const openFile = useCallback(async (path: string) => {
      try {
        const res = await fetch(`/api/files${path}`);
        if (res.ok) {
          const content = await res.text();
          setSelectedFile({ path, content });
        } else {
          setSelectedFile({ path, content: '(error reading file)' });
        }
      } catch {
        setSelectedFile({ path, content: '(error reading file)' });
      }
    }, []);

    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-kumo-line flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpenIcon size={14} className="text-kumo-accent shrink-0" />
            <span className="text-xs font-mono text-kumo-default truncate">
              /workspace
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="Refresh"
            icon={<ArrowCounterClockwiseIcon size={12} />}
            onClick={refresh}
            disabled={loading}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center">
              <Text size="xs" variant="secondary">
                Loading...
              </Text>
            </div>
          ) : tree.length === 0 ? (
            <div className="p-4 text-center">
              <Empty
                size="sm"
                icon={<FolderIcon size={24} />}
                title="Workspace is empty"
                description="Ask the AI to create some files"
              />
            </div>
          ) : (
            <div className="py-1">
              {tree.map((node) => (
                <TreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedFile?.path ?? null}
                  onSelect={openFile}
                />
              ))}
            </div>
          )}
        </div>

        {selectedFile && (
          <div className="border-t border-kumo-line flex flex-col max-h-[40%]">
            <div className="px-3 py-1.5 flex items-center justify-between border-b border-kumo-line bg-kumo-elevated">
              <span className="text-[10px] font-mono text-kumo-default truncate">
                {selectedFile.path.split('/').pop()}
              </span>
              <button
                type="button"
                onClick={() => setSelectedFile(null)}
                className="text-kumo-inactive hover:text-kumo-default text-xs"
              >
                ×
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed font-mono text-kumo-default bg-kumo-base whitespace-pre-wrap break-all">
              {selectedFile.content}
            </pre>
          </div>
        )}

        {info && (info.fileCount > 0 || info.directoryCount > 0) && (
          <div className="px-3 py-2 border-t border-kumo-line">
            <span className="text-[10px] text-kumo-inactive">
              {info.fileCount} file{info.fileCount !== 1 ? 's' : ''},{' '}
              {info.directoryCount} dir
              {info.directoryCount !== 1 ? 's' : ''},{' '}
              {info.totalBytes > 1024
                ? `${(info.totalBytes / 1024).toFixed(1)} KB`
                : `${info.totalBytes} B`}
            </span>
          </div>
        )}
      </div>
    );
  }
);

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem('theme') || 'light'
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-mode', mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem('theme', mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === 'light' ? 'dark' : 'light'))}
      icon={mode === 'light' ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string }).text)
    .join('');
}

// ---------------------------------------------------------------------------
// Main Chat component
// ---------------------------------------------------------------------------

type PendingFile = {
  id: string;
  name: string;
  size: number;
  progress: number; // 0–1
  status: 'uploading' | 'done' | 'error';
  sandboxPath?: string;
  abort: AbortController;
};

function Chat() {
  const [input, setInput] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const dragCounter = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  const toasts = useKumoToastManager();
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const toggleTool = useCallback((toolCallId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolCallId)) {
        next.delete(toolCallId);
      } else {
        next.add(toolCallId);
      }
      return next;
    });
  }, []);
  const { messages, sendMessage, setMessages, stop, status } = useChat({
    api: '/api/chat'
  });

  const isStreaming = status === 'streaming';

  // Track the most recent tool call ID and auto-expand it
  const latestToolIdRef = useRef<string | null>(null);
  useEffect(() => {
    let lastToolId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (isToolUIPart(part)) {
          lastToolId = part.toolCallId;
          break;
        }
      }
      if (lastToolId) break;
    }
    if (lastToolId && lastToolId !== latestToolIdRef.current) {
      latestToolIdRef.current = lastToolId;
      setExpandedTools(new Set([lastToolId]));
    }
  }, [messages]);

  // Restore chat history from the backend on mount
  const historyLoaded = useRef(false);
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    fetch('/api/history')
      .then((res) => (res.ok ? res.json() : []))
      .then((saved) => {
        if (saved.length > 0) setMessages(saved);
      })
      .catch(() => {});
  }, [setMessages]);

  // Persist chat history whenever messages change and we're not streaming
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (isStreaming || messages.length === 0) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch('/api/history', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages)
      }).catch(() => {});
    }, 1000);
  }, [messages, isStreaming]);

  // Fetch a recursive flat file tree from the workspace
  const fetchTree = useCallback(async (): Promise<
    { path: string; size: number }[]
  > => {
    try {
      const res = await fetch('/api/files-tree');
      if (res.ok) return await res.json();
    } catch {
      /* ignore */
    }
    return [];
  }, []);

  // Capture a recursive snapshot of all workspace files when streaming starts
  const preStreamTreeRef = useRef<{ path: string; size: number }[]>([]);
  useEffect(() => {
    if (isStreaming) {
      fetchTree().then((tree) => {
        preStreamTreeRef.current = tree;
      });
    }
  }, [isStreaming, fetchTree]);

  // Poll the file browser while the agent is streaming so changes appear live
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(
      () => fileBrowserRef.current?.refresh({ silent: true }),
      1500
    );
    return () => clearInterval(id);
  }, [isStreaming]);

  // When streaming finishes, diff the recursive tree and show a detailed toast
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      fileBrowserRef.current?.refresh();
      fetchTree().then((afterTree) => {
        const beforeTree = preStreamTreeRef.current;
        const beforeMap = new Map(beforeTree.map((e) => [e.path, e]));
        const afterMap = new Map(afterTree.map((e) => [e.path, e]));

        const added = afterTree.filter((e) => !beforeMap.has(e.path));
        const removed = beforeTree.filter((e) => !afterMap.has(e.path));
        const modified = afterTree.filter((e) => {
          const prev = beforeMap.get(e.path);
          return prev && prev.size !== e.size;
        });

        const total = added.length + removed.length + modified.length;
        if (total === 0) return;

        const lines: string[] = [];
        const shortName = (p: string) => p.split('/').pop() ?? p;
        if (added.length > 0) {
          if (added.length <= 3) {
            lines.push(...added.map((e) => `+ ${shortName(e.path)}`));
          } else {
            lines.push(`+ ${added.length} files created`);
          }
        }
        if (modified.length > 0) {
          if (modified.length <= 3) {
            lines.push(...modified.map((e) => `Δ ${shortName(e.path)}`));
          } else {
            lines.push(`Δ ${modified.length} files modified`);
          }
        }
        if (removed.length > 0) {
          if (removed.length <= 3) {
            lines.push(...removed.map((e) => `− ${shortName(e.path)}`));
          } else {
            lines.push(`− ${removed.length} files deleted`);
          }
        }

        toasts.add({
          title: `Workspace updated — ${total} file${total !== 1 ? 's' : ''} changed`,
          description: lines.join('\n'),
          variant: 'info',
          timeout: 4000
        });
      });
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, toasts, fetchTree]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const hasUploading = pendingFiles.some((f) => f.status === 'uploading');

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.status === 'uploading') file.abort.abort();
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming || hasUploading) return;
    // Append uploaded file paths so the agent knows about them
    const doneFiles = pendingFiles.filter(
      (f) => f.status === 'done' && f.sandboxPath
    );
    let fullText = text;
    if (doneFiles.length > 0) {
      const fileList = doneFiles.map((f) => f.sandboxPath).join(', ');
      fullText = `${text}\n\n[Uploaded files: ${fileList}]`;
    }
    setInput('');
    setPendingFiles([]);
    sendMessage({ text: fullText });
  }, [input, isStreaming, hasUploading, pendingFiles, sendMessage]);

  const [isResetting, setIsResetting] = useState(false);

  const clearAndReset = useCallback(async () => {
    setIsResetting(true);
    try {
      setMessages([]);
      setPendingFiles([]);
      await fetch('/api/reset', { method: 'POST' });
      fileBrowserRef.current?.refresh();
      toasts.add({ title: 'Workspace reset', variant: 'info', timeout: 3000 });
    } catch {
      toasts.add({ title: 'Reset failed', variant: 'error', timeout: 4000 });
    } finally {
      setIsResetting(false);
    }
  }, [setMessages, toasts]);

  // ---------------------------------------------------------------------------
  // Drag-and-drop file upload (full window)
  // ---------------------------------------------------------------------------

  const handleDrop = useCallback(
    (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      const newPending: PendingFile[] = files.map((file) => {
        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const abort = new AbortController();
        return {
          id,
          name: file.name,
          size: file.size,
          progress: 0,
          status: 'uploading' as const,
          abort
        };
      });

      setPendingFiles((prev) => [...prev, ...newPending]);

      // Start uploads in background. We use XMLHttpRequest for progress tracking.
      files.forEach((file, i) => {
        const entry = newPending[i];
        const xhr = new XMLHttpRequest();
        const abort = entry.abort;

        abort.signal.addEventListener('abort', () => xhr.abort());

        xhr.upload.addEventListener('progress', (ev) => {
          if (ev.lengthComputable) {
            const progress = ev.loaded / ev.total;
            setPendingFiles((prev) =>
              prev.map((f) => (f.id === entry.id ? { ...f, progress } : f))
            );
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const { uploaded } = JSON.parse(xhr.responseText) as {
                uploaded: { path: string; size: number }[];
              };
              const sandboxPath = uploaded[0]?.path;
              setPendingFiles((prev) =>
                prev.map((f) =>
                  f.id === entry.id
                    ? {
                        ...f,
                        status: 'done' as const,
                        progress: 1,
                        sandboxPath
                      }
                    : f
                )
              );
              fileBrowserRef.current?.refresh({ silent: true });
            } catch {
              setPendingFiles((prev) =>
                prev.map((f) =>
                  f.id === entry.id ? { ...f, status: 'error' as const } : f
                )
              );
            }
          } else {
            toasts.add({
              title: `Upload failed: ${file.name}`,
              variant: 'error',
              timeout: 4000
            });
            setPendingFiles((prev) =>
              prev.map((f) =>
                f.id === entry.id ? { ...f, status: 'error' as const } : f
              )
            );
          }
        });

        xhr.addEventListener('error', () => {
          toasts.add({
            title: `Upload failed: ${file.name}`,
            variant: 'error',
            timeout: 4000
          });
          setPendingFiles((prev) =>
            prev.map((f) =>
              f.id === entry.id ? { ...f, status: 'error' as const } : f
            )
          );
        });

        xhr.addEventListener('abort', () => {
          setPendingFiles((prev) => prev.filter((f) => f.id !== entry.id));
        });

        const formData = new FormData();
        formData.append(file.name, file);
        xhr.open('POST', '/api/upload');
        xhr.send(formData);
      });
    },
    [toasts]
  );

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current++;
      if (dragCounter.current === 1) setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current--;
      if (dragCounter.current === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      handleDrop(e);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleDrop]);

  return (
    <div className="flex h-screen bg-kumo-elevated relative">
      {/* Full-window drag overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kumo-contrast/20 backdrop-blur-sm border-2 border-dashed border-kumo-accent pointer-events-none">
          <div className="text-lg font-semibold text-kumo-default bg-kumo-base px-6 py-3 rounded-xl shadow-lg">
            Drop files to upload to workspace
          </div>
        </div>
      )}

      {/* Sidebar — File Browser */}
      <div className="w-64 border-r border-kumo-line bg-kumo-base flex flex-col shrink-0">
        <div className="px-3 h-[61px] min-h-[61px] border-b border-kumo-line flex items-center">
          <div className="flex items-center gap-2">
            <TerminalIcon size={16} className="text-kumo-accent" />
            <span className="text-sm font-semibold text-kumo-default">
              Workspace
            </span>
          </div>
        </div>
        <FileBrowser ref={fileBrowserRef} />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-kumo-default">
                Workspace Chat
              </h1>
              <Badge variant="secondary">
                <TerminalIcon size={12} weight="bold" className="mr-1" />
                AI + Files
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <ModeToggle />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={clearAndReset}
                disabled={isResetting || isStreaming}
              >
                {isResetting ? 'Resetting…' : 'Reset'}
              </Button>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {/* Explainer */}
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="flex gap-3">
                <InfoIcon
                  size={20}
                  weight="bold"
                  className="text-kumo-accent shrink-0 mt-0.5"
                />
                <div>
                  <Text size="sm" bold>
                    Workspace Chat
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      An AI assistant with a persistent sandboxed filesystem.
                      Ask it to create files, write code, explore the workspace,
                      or run shell commands. Files persist across conversations.
                    </Text>
                  </span>
                </div>
              </div>
            </Surface>

            {messages.length === 0 && (
              <Empty
                icon={<TerminalIcon size={32} />}
                title="Start building"
                description='Try "Create a hello world HTML page at /index.html" or "Show me what files are in the workspace"'
              />
            )}

            {messages.map((message, index) => {
              const isUser = message.role === 'user';
              const isLastAssistant =
                message.role === 'assistant' && index === messages.length - 1;

              if (isUser) {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse text-sm leading-relaxed">
                      {getMessageText(message)}
                    </div>
                  </div>
                );
              }

              return (
                <div key={message.id} className="space-y-2">
                  {message.parts.map((part, partIndex) => {
                    if (part.type === 'text') {
                      if (!part.text) return null;
                      const isLastTextPart = message.parts
                        .slice(partIndex + 1)
                        .every((p) => p.type !== 'text');
                      const htmlArtifacts = extractHtmlArtifacts(part.text);

                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: message parts lack stable IDs
                        <div key={`text-${partIndex}`} className="space-y-2">
                          <div className="flex justify-start">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default text-sm leading-relaxed">
                              <Streamdown
                                className="sd-theme"
                                plugins={{ code }}
                                controls={false}
                                isAnimating={
                                  isLastAssistant &&
                                  isLastTextPart &&
                                  isStreaming
                                }
                              >
                                {part.text}
                              </Streamdown>
                            </div>
                          </div>
                          {htmlArtifacts.map((artifactSrc) => (
                            <div key={artifactSrc} className="max-w-[85%]">
                              <HtmlPreview src={artifactSrc} />
                            </div>
                          ))}
                        </div>
                      );
                    }

                    if (part.type === 'reasoning') {
                      if (!part.text) return null;
                      const reasoningKey = `reasoning-${message.id}-${partIndex}`;
                      const isExpanded = expandedTools.has(reasoningKey);
                      return (
                        <div
                          // biome-ignore lint/suspicious/noArrayIndexKey: message parts lack stable IDs
                          key={`reasoning-${partIndex}`}
                          className="flex justify-start"
                        >
                          <Surface className="max-w-[85%] rounded-xl ring ring-kumo-line overflow-hidden">
                            <button
                              type="button"
                              onClick={() => toggleTool(reasoningKey)}
                              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-kumo-elevated/50 transition-colors"
                            >
                              <CaretRightIcon
                                size={12}
                                weight="bold"
                                className={`text-kumo-inactive shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                              />
                              <GearIcon
                                size={12}
                                className="text-kumo-inactive"
                              />
                              <Text size="xs" variant="secondary">
                                Thinking
                              </Text>
                            </button>
                            {isExpanded && (
                              <div className="px-4 pb-3 pt-1">
                                <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-kumo-subtle italic">
                                  {part.text}
                                </div>
                              </div>
                            )}
                          </Surface>
                        </div>
                      );
                    }

                    if (!isToolUIPart(part)) return null;
                    const toolName = getToolName(part);

                    if (part.state === 'output-available') {
                      const inputStr = JSON.stringify(part.input, null, 2);
                      const outputStr = JSON.stringify(part.output, null, 2);
                      return (
                        <div key={part.toolCallId}>
                          <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
                            <ToolDetail
                              open={expandedTools.has(part.toolCallId)}
                              onToggle={() => toggleTool(part.toolCallId)}
                              label={
                                <div className="flex items-center gap-2">
                                  <CheckIcon
                                    size={14}
                                    weight="bold"
                                    className="text-kumo-success"
                                  />
                                  <Text size="xs" variant="secondary" bold>
                                    {toolName}
                                  </Text>
                                  <Badge variant="secondary">Done</Badge>
                                </div>
                              }
                            >
                              <div className="px-4 pb-3 space-y-2">
                                <div>
                                  <span className="block text-[10px] text-kumo-inactive uppercase tracking-wide mb-1">
                                    Input
                                  </span>
                                  <div className="max-h-48 overflow-y-auto bg-kumo-elevated rounded-md px-3 py-2">
                                    <HighlightedJson value={inputStr} />
                                  </div>
                                </div>
                                <div>
                                  <span className="block text-[10px] text-kumo-inactive uppercase tracking-wide mb-1">
                                    Output
                                  </span>
                                  <div className="max-h-64 overflow-y-auto bg-kumo-elevated rounded-md px-3 py-2">
                                    <HighlightedJson value={outputStr} />
                                  </div>
                                </div>
                              </div>
                            </ToolDetail>
                          </Surface>
                        </div>
                      );
                    }

                    if (
                      part.state === 'input-available' ||
                      part.state === 'input-streaming'
                    ) {
                      const inputStr =
                        part.input && Object.keys(part.input).length > 0
                          ? JSON.stringify(part.input, null, 2)
                          : null;
                      return (
                        <div key={part.toolCallId}>
                          <Surface className="px-4 py-2.5 rounded-xl ring ring-kumo-line">
                            <div className="flex items-center gap-2 mb-1">
                              <GearIcon
                                size={14}
                                className="text-kumo-inactive animate-spin"
                              />
                              <Text size="xs" variant="secondary" bold>
                                {toolName}
                              </Text>
                              <Text size="xs" variant="secondary">
                                running…
                              </Text>
                            </div>
                            {inputStr && (
                              <div className="max-h-48 overflow-y-auto bg-kumo-elevated rounded-md px-3 py-2 mt-1.5">
                                <HighlightedJson value={inputStr} />
                              </div>
                            )}
                          </Surface>
                        </div>
                      );
                    }

                    return null;
                  })}
                </div>
              );
            })}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="max-w-3xl mx-auto px-5 py-4"
          >
            <div className="rounded-xl border border-kumo-line bg-kumo-base shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
              <div className="flex items-end gap-3 p-3">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder='Try: "Create a Node.js project with package.json and src/index.ts"'
                  disabled={isStreaming}
                  rows={2}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop streaming"
                    onClick={stop}
                    icon={<StopIcon size={18} weight="fill" />}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || hasUploading}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>

              {/* Pending file pills */}
              {pendingFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pb-3">
                  {pendingFiles.map((file) => (
                    <div
                      key={file.id}
                      className="relative flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full text-xs overflow-hidden border border-kumo-line"
                    >
                      {/* Progress fill background */}
                      <div
                        className={`absolute inset-0 transition-all duration-300 ${
                          {
                            uploading: 'bg-kumo-accent/10',
                            done: 'bg-kumo-accent/15',
                            error: 'bg-kumo-danger/10'
                          }[file.status]
                        }`}
                        style={{
                          width:
                            file.status === 'error'
                              ? '100%'
                              : `${Math.round(file.progress * 100)}%`
                        }}
                      />
                      <FileIcon
                        size={12}
                        className="text-kumo-subtle shrink-0 relative z-10"
                      />
                      <span className="text-kumo-default truncate max-w-[150px] relative z-10">
                        {file.name}
                      </span>
                      {file.status === 'uploading' && (
                        <span className="text-kumo-inactive relative z-10">
                          {Math.round(file.progress * 100)}%
                        </span>
                      )}
                      {file.status === 'error' && (
                        <span className="text-kumo-danger relative z-10">
                          failed
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFile(file.id)}
                        className="relative z-10 text-kumo-inactive hover:text-kumo-default p-0.5 rounded-full hover:bg-kumo-elevated transition-colors"
                        aria-label={`Remove ${file.name}`}
                      >
                        <XCircleIcon size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
