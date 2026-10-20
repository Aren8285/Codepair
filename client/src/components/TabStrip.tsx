import { baseName } from '../lib/language';
import type { EditorStatus } from '../lib/status';
import { Icon } from './Icon';

interface TabStripProps {
  tabs: Array<{ path: string; status?: EditorStatus }>;
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onQuickOpen: () => void;
}

export function TabStrip({ tabs, activePath, onSelect, onClose, onQuickOpen }: TabStripProps) {
  return (
    <div className="tabs" role="tablist" aria-label="Open files">
      <div className="tabs__scroll">
        {tabs.map(({ path, status }) => {
          const active = path === activePath;
          const dirty = status?.save === 'saving' || status?.save === 'error';
          const offline = status?.connection === 'offline' || status?.connection === 'reconnecting';
          return (
            <div key={path} className={`tab${active ? ' is-active' : ''}`} role="presentation">
              <button
                role="tab"
                aria-selected={active}
                className="tab__select"
                onClick={() => onSelect(path)}
                title={path}
              >
                <span className={`tab__dot${dirty ? ' tab__dot--dirty' : offline ? ' tab__dot--offline' : ''}`} aria-hidden="true" />
                <span className="tab__name">{baseName(path)}</span>
                {dirty ? <span className="sr-only">unsaved changes</span> : null}
              </button>
              <button className="tab__close" onClick={() => onClose(path)} aria-label={`Close ${baseName(path)}`}>
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="tabs__add" onClick={onQuickOpen} aria-label="Open another file" title="Quick open (⌘/Ctrl P)">
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}
