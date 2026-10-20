import { useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../lib/api';
import { extensionOf } from '../lib/language';
import { Icon } from './Icon';

interface FileTreeProps {
  rootName: string;
  readOnly: boolean;
  mobileOpen: boolean;
  childrenByDir: Record<string, FileEntry[] | undefined>;
  expanded: Set<string>;
  loadingDirs: Set<string>;
  activePath: string | null;
  onCloseMobile: () => void;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

export function FileTree({
  rootName,
  readOnly,
  mobileOpen,
  childrenByDir,
  expanded,
  loadingDirs,
  activePath,
  onCloseMobile,
  onToggleDir,
  onOpenFile,
  onRefresh,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: FileTreeProps) {
  const rootEntries = childrenByDir[''];
  const asideRef = useRef<HTMLElement>(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setIsMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // A closed off-canvas drawer must not stay focusable or visible to AT.
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const closed = isMobile && !mobileOpen;
    aside.inert = closed;
    if (closed && aside.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [isMobile, mobileOpen]);

  return (
    <>
      <div className={`sidebar-scrim${mobileOpen ? ' is-open' : ''}`} onClick={onCloseMobile} aria-hidden="true" />
      <aside
        ref={asideRef}
        id="file-explorer"
        className={`sidebar${mobileOpen ? ' is-open' : ''}`}
        aria-label="File explorer"
        aria-hidden={isMobile && !mobileOpen}
      >
        <div className="sidebar__head">
          <div className="sidebar__identity">
            <span className="sidebar__eyebrow">Explorer</span>
            <h2 className="sidebar__root" title={rootName}>{rootName}</h2>
          </div>
          <div className="sidebar__tools">
            <button className="icon-button" onClick={onRefresh} title="Refresh files" aria-label="Refresh files">
              <Icon name="refresh" size={15} />
            </button>
            {!readOnly ? (
              <>
                <button className="icon-button" onClick={() => onNewFile('')} title="New file" aria-label="New file">
                  <Icon name="file-plus" size={16} />
                </button>
                <button className="icon-button" onClick={() => onNewFolder('')} title="New folder" aria-label="New folder">
                  <Icon name="folder-plus" size={16} />
                </button>
              </>
            ) : null}
            <button className="icon-button sidebar__close" onClick={onCloseMobile} aria-label="Close explorer">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        <div className="sidebar__tree" role="tree" aria-label={`${rootName} files`}>
          {rootEntries === undefined ? (
            <TreeSkeleton />
          ) : rootEntries.length === 0 ? (
            <div className="tree-empty">
              <p>This folder is empty.</p>
              {!readOnly ? (
                <button className="text-button" onClick={() => onNewFile('')}>
                  <Icon name="plus" size={13} /> Create a file
                </button>
              ) : null}
            </div>
          ) : (
            rootEntries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                childrenByDir={childrenByDir}
                expanded={expanded}
                loadingDirs={loadingDirs}
                activePath={activePath}
                readOnly={readOnly}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))
          )}
        </div>

        <div className="sidebar__footer">
          <span className={`sidebar__mode${readOnly ? ' sidebar__mode--read' : ''}`}>
            <Icon name={readOnly ? 'lock' : 'check'} size={13} />
            {readOnly ? 'Read-only access' : 'Live editing'}
          </span>
          <span className="sidebar__hint" title="All paths are confined to the project root">
            Sandboxed
          </span>
        </div>
      </aside>
    </>
  );
}

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  childrenByDir: Record<string, FileEntry[] | undefined>;
  expanded: Set<string>;
  loadingDirs: Set<string>;
  activePath: string | null;
  readOnly: boolean;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

function TreeNode({
  entry,
  depth,
  childrenByDir,
  expanded,
  loadingDirs,
  activePath,
  readOnly,
  onToggleDir,
  onOpenFile,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: TreeNodeProps) {
  const isDirectory = entry.type === 'directory';
  const isOpen = expanded.has(entry.path);
  const isLoading = loadingDirs.has(entry.path);
  const children = childrenByDir[entry.path];
  const isActive = activePath === entry.path;
  const indent = { paddingLeft: `${8 + depth * 14}px` } as const;

  return (
    <div className="tree-node" role="treeitem" aria-expanded={isDirectory ? isOpen : undefined} aria-level={depth + 1}>
      <div className={`tree-row${isActive ? ' is-active' : ''}${entry.blocked ? ' is-blocked' : ''}`} style={indent}>
        {isDirectory ? (
          <button
            className="tree-row__main tree-row__main--dir"
            onClick={() => onToggleDir(entry.path)}
            title={entry.path}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${entry.name}`}
          >
            <span className="tree-row__chevron">
              {isLoading ? (
                <span className="spinner spinner--small" />
              ) : (
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
              )}
            </span>
            <span className="tree-row__glyph tree-row__glyph--dir">
              <Icon name={isOpen ? 'folder-open' : 'folder'} size={15} />
            </span>
            <span className="tree-row__name">{entry.name}</span>
          </button>
        ) : (
          <button
            className="tree-row__main"
            onClick={() => !entry.blocked && onOpenFile(entry.path)}
            title={entry.blocked ? 'This symlink points outside the project and cannot be opened.' : entry.path}
            disabled={entry.blocked}
            aria-current={isActive ? 'true' : undefined}
          >
            <span className="tree-row__chevron" aria-hidden="true" />
            <span className="tree-row__glyph">
              {entry.blocked ? <Icon name="lock" size={14} /> : <Icon name="file" size={15} />}
            </span>
            <span className="tree-row__name">{entry.name}</span>
          </button>
        )}

        {!readOnly ? (
          <span className="tree-row__actions">
            {isDirectory ? (
              <>
                <button
                  className="tree-action"
                  onClick={() => onNewFile(entry.path)}
                  title={`New file in ${entry.name}`}
                  aria-label={`New file in ${entry.name}`}
                >
                  <Icon name="file-plus" size={13} />
                </button>
                <button
                  className="tree-action"
                  onClick={() => onNewFolder(entry.path)}
                  title={`New folder in ${entry.name}`}
                  aria-label={`New folder in ${entry.name}`}
                >
                  <Icon name="folder-plus" size={13} />
                </button>
              </>
            ) : null}
            <button className="tree-action" onClick={() => onRename(entry)} title="Rename" aria-label={`Rename ${entry.name}`}>
              <Icon name="pencil" size={13} />
            </button>
            <button
              className="tree-action tree-action--danger"
              onClick={() => onDelete(entry)}
              title="Delete"
              aria-label={`Delete ${entry.name}`}
            >
              <Icon name="trash" size={13} />
            </button>
          </span>
        ) : null}
      </div>

      {isDirectory && isOpen ? (
        isLoading && children === undefined ? (
          <div style={{ paddingLeft: `${22 + depth * 14}px` }} className="tree-loading-row">
            <span className="spinner spinner--small" /> Loading
          </div>
        ) : children && children.length > 0 ? (
          <div role="group">
            {children.map((child) => (
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                childrenByDir={childrenByDir}
                expanded={expanded}
                loadingDirs={loadingDirs}
                activePath={activePath}
                readOnly={readOnly}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        ) : (
          <div style={{ paddingLeft: `${30 + depth * 14}px` }} className="tree-empty-dir">
            Empty folder
          </div>
        )
      ) : null}
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="tree-skeleton" aria-label="Loading files" role="status">
      {[68, 84, 54, 72, 60, 88, 46].map((width, index) => (
        <div key={index} className="tree-skeleton__row" style={{ animationDelay: `${index * 55}ms` }}>
          <span className="tree-skeleton__chevron" />
          <span className="tree-skeleton__bar" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

export function fileTone(name: string): string {
  switch (extensionOf(name)) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'blue';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'amber';
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return 'gold';
    case 'css':
    case 'scss':
    case 'less':
      return 'cyan';
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return 'rose';
    case 'md':
    case 'mdx':
      return 'slate';
    case 'py':
      return 'green';
    case 'go':
    case 'rs':
    case 'c':
    case 'cpp':
    case 'h':
      return 'violet';
    default:
      return 'muted';
  }
}
