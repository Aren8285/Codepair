import type { ConnectionState } from './docProvider';

export type SaveState = 'saved' | 'saving' | 'error';

export interface EditorStatus {
  connection: ConnectionState;
  save: SaveState;
  savedAt?: number;
  fatal?: { code: number; message: string };
}

export interface CursorState {
  line: number;
  column: number;
  selected: number;
}

export interface Participant {
  id: number;
  name: string;
  color: string;
  self?: boolean;
}
