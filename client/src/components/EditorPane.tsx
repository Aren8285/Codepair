import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { MonacoBinding } from 'y-monaco';
import * as Y from 'yjs';
import { DocProvider, type ConnectionState, type DocMeta } from '../lib/docProvider';
import { languageForPath } from '../lib/language';
import { currentPresence } from '../lib/presence';
import { MONACO_THEME, monaco } from '../lib/monaco';
import type { CursorState, EditorStatus, Participant } from '../lib/status';

interface EditorPaneProps {
  token: string;
  roomId: string;
  path: string;
  active: boolean;
  readOnly: boolean;
  onStatus: (path: string, status: EditorStatus) => void;
  onPresence: (path: string, participants: Participant[]) => void;
  onCursor: (path: string, cursor: CursorState) => void;
  onFatal: (path: string, message: string, code: number) => void;
  onToast: (kind: 'success' | 'error' | 'info' | 'warning', message: string, detail?: string) => void;
  registerContent: (path: string, getter: (() => string) | null) => void;
}

const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

export function EditorPane({
  token,
  roomId,
  path,
  active,
  readOnly,
  onStatus,
  onPresence,
  onCursor,
  onFatal,
  onToast,
  registerContent,
}: EditorPaneProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const providerRef = useRef<DocProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const listenersRef = useRef<monaco.IDisposable[]>([]);
  const decorationsRef = useRef<string[]>([]);
  const decorationFrameRef = useRef<number | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.codepairCursors = path;
    document.head.append(style);
    styleRef.current = style;
    return () => {
      style.remove();
      styleRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    return () => {
      if (decorationFrameRef.current !== null) {
        window.cancelAnimationFrame(decorationFrameRef.current);
        decorationFrameRef.current = null;
      }
      decorationsRef.current = [];
      for (const listener of listenersRef.current.splice(0)) listener.dispose();
      registerContent(path, null);
      bindingRef.current?.destroy();
      bindingRef.current = null;
      providerRef.current?.destroy();
      providerRef.current = null;
      editorRef.current = null;
    };
  }, [path, registerContent]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly,
      domReadOnly: readOnly,
      readOnlyMessage: { value: 'This session is read-only.' },
    });
  }, [readOnly]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.layout();
      if (!window.matchMedia('(pointer: coarse)').matches) editor.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    const model = editor.getModel();
    if (!model) return;

    const provider = new DocProvider({
      token,
      roomId,
      path,
      user: currentPresence(),
      onStatus: (state) => {
        setConnection(state);
        onStatus(path, { connection: state, save: 'saved' });
      },
      onDirty: () => {
        onStatus(path, { connection: 'synced', save: 'saving' });
      },
      onMeta: (meta: DocMeta) => {
        if (meta.type === 'ready') {
          onStatus(path, { connection: 'synced', save: 'saved', savedAt: meta.savedAt });
        } else if (meta.type === 'saved') {
          onStatus(path, { connection: 'synced', save: 'saved', savedAt: meta.savedAt });
        } else if (meta.type === 'denied') {
          onToast('warning', 'Read-only session', meta.reason);
          setConnection('offline');
        } else if (meta.type === 'external') {
          onToast(
            meta.conflict ? 'warning' : 'info',
            meta.conflict ? 'File changed on the Host' : 'Updated on the Host',
            meta.message,
          );
        } else if (meta.type === 'error') {
          onToast('error', 'Save failed', meta.message);
          onStatus(path, { connection: 'synced', save: 'error' });
        }
      },
      onFatal: (reason, code) => onFatal(path, reason, code),
    });
    providerRef.current = provider;
    registerContent(path, () => provider.text.toString());

    // Text binding only. y-monaco renders remote selections by calling
    // `deltaDecorations` synchronously inside awareness events, which re-enters
    // Monaco during concurrent edits and throws "Invoking deltaDecorations
    // recursively". Remote cursors are rendered below on a coalesced frame.
    bindingRef.current = new MonacoBinding(provider.text, model, new Set([editor]));

    const renderDecorations = () => {
      decorationFrameRef.current = null;
      if (editorRef.current !== editor || editor.getModel() !== model) return;
      const next: monaco.editor.IModelDeltaDecoration[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.doc.clientID) return;
        const selection = state.selection as { anchor?: Y.RelativePosition; head?: Y.RelativePosition } | undefined;
        if (!selection?.anchor || !selection.head) return;
        const anchor = Y.createAbsolutePositionFromRelativePosition(selection.anchor, provider.doc);
        const head = Y.createAbsolutePositionFromRelativePosition(selection.head, provider.doc);
        if (!anchor || !head || anchor.type !== provider.text || head.type !== provider.text) return;
        const start = model.getPositionAt(Math.min(anchor.index, head.index));
        const end = model.getPositionAt(Math.max(anchor.index, head.index));
        const forward = anchor.index <= head.index;
        const headClass = `yRemoteSelectionHead yRemoteSelectionHead-${clientId}`;
        next.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: {
            className: `yRemoteSelection yRemoteSelection-${clientId}`,
            afterContentClassName: forward ? headClass : undefined,
            beforeContentClassName: forward ? undefined : headClass,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      });
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, next);
    };

    const scheduleDecorations = () => {
      if (decorationFrameRef.current !== null) return;
      decorationFrameRef.current = window.requestAnimationFrame(renderDecorations);
    };

    const updatePresence = () => {
      const participants: Participant[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        const user = state.user as { name?: string; color?: string } | undefined;
        if (!user?.name) return;
        participants.push({
          id: clientId,
          name: user.name,
          color: /^#[0-9a-f]{6}$/i.test(user.color ?? '') ? user.color! : '#7c8cf8',
          self: clientId === provider.doc.clientID,
        });
      });
      participants.sort((left, right) => (left.self ? -1 : right.self ? 1 : left.name.localeCompare(right.name)));
      onPresence(path, participants);
      applyCursorStyles(provider, styleRef.current);
      scheduleDecorations();
    };

    provider.awareness.on('change', updatePresence);
    listenersRef.current.push({ dispose: () => provider.awareness.off('change', updatePresence) });
    provider.text.observe(scheduleDecorations);
    listenersRef.current.push({ dispose: () => provider.text.unobserve(scheduleDecorations) });
    updatePresence();

    const updateSelection = () => {
      const selection = editor.getSelection();
      if (!selection) return;
      const anchorPosition = {
        lineNumber: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn,
      };
      const anchor = Y.createRelativePositionFromTypeIndex(provider.text, model.getOffsetAt(anchorPosition));
      const head = Y.createRelativePositionFromTypeIndex(provider.text, model.getOffsetAt(selection.getPosition()));
      provider.awareness.setLocalStateField('selection', { anchor, head });
    };
    listenersRef.current.push(editor.onDidChangeCursorSelection(updateSelection));
    updateSelection();

    listenersRef.current.push(
      editor.onDidChangeCursorPosition((event) => {
        const selection = editor.getSelection();
        const anchorOffset = selection
          ? model.getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn })
          : 0;
        onCursor(path, {
          line: event.position.lineNumber,
          column: event.position.column,
          selected: selection ? Math.abs(model.getOffsetAt(selection.getPosition()) - anchorOffset) : 0,
        });
      }),
    );

    listenersRef.current.push(
      editor.onKeyDown((event) => {
        if ((event.metaKey || event.ctrlKey) && event.keyCode === monaco.KeyCode.KeyS) {
          event.preventDefault();
          provider.requestSave();
        }
      }),
    );

    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(editor.getDomNode() ?? document.body);
    listenersRef.current.push({ dispose: () => observer.disconnect() });

    editor.updateOptions({
      readOnly,
      domReadOnly: readOnly,
      readOnlyMessage: { value: 'This session is read-only.' },
    });
    if (active) window.requestAnimationFrame(() => editor.layout());
  };

  return (
    <div className={`editorPane${active ? ' is-active' : ''}`} aria-hidden={!active}>
      <Editor
        path={path}
        language={languageForPath(path)}
        theme={MONACO_THEME}
        onMount={handleMount}
        loading={<div className="editorLoading"><span className="spinner" /> Opening {path}</div>}
        options={{
          automaticLayout: true,
          fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13.5,
          lineHeight: 1.65,
          letterSpacing: 0.1,
          minimap: { enabled: isDesktop(), renderCharacters: false, maxColumn: 90 },
          padding: { top: 14, bottom: 24 },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'all',
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          wordWrap: 'off',
          tabSize: 2,
          formatOnPaste: true,
          fixedOverflowWidgets: true,
          mouseWheelZoom: true,
          readOnly,
        }}
      />
      {connection === 'reconnecting' || connection === 'connecting' ? (
        <div className="editorPane__banner" role="status">
          <span className="spinner spinner--small" />
          {connection === 'connecting' ? 'Opening document…' : 'Reconnecting — edits are kept locally.'}
        </div>
      ) : null}
      {connection === 'offline' ? (
        <div className="editorPane__banner editorPane__banner--offline" role="status">
          Offline — this pane is read-only until the connection returns.
        </div>
      ) : null}
    </div>
  );
}

function applyCursorStyles(provider: DocProvider, style: HTMLStyleElement | null): void {
  if (!style) return;
  const rules: string[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === provider.doc.clientID) return;
    const user = state.user as { name?: string; color?: string } | undefined;
    if (!user?.name) return;
    const color = /^#[0-9a-f]{6}$/i.test(user.color ?? '') ? user.color! : '#7c8cf8';
    const label = JSON.stringify(user.name.slice(0, 40));
    rules.push(`.yRemoteSelection-${clientId}{background:${color}33;border-radius:2px;}`);
    rules.push(`.yRemoteSelectionHead-${clientId}{border-left:2px solid ${color};position:relative;}`);
    rules.push(
      `.yRemoteSelectionHead-${clientId}::after{content:${label};position:absolute;top:-1.45em;left:-1px;` +
        `background:${color};color:#08111a;font-family:'IBM Plex Sans',system-ui,sans-serif;font-size:10px;` +
        `font-weight:600;line-height:1;padding:3px 5px;border-radius:3px 3px 3px 0;white-space:nowrap;` +
        `pointer-events:none;z-index:30;}`,
    );
  });
  style.textContent = rules.join('\n');
}
