/**
 * Per-session interview state: consent, integrity evidence and bounded replay
 * data. This is evidence for a human interviewer, not a tamper-proof detector.
 */

export const MAX_INTEGRITY_EVENTS = 2000;
export const MAX_REPLAY_UPDATES = 2000;
export const MAX_REPLAY_SNAPSHOTS = 256;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_EVENT_BATCH = 100;

export type IntegrityEventType =
  | 'visibility'
  | 'blur'
  | 'focus'
  | 'fullscreen-enter'
  | 'fullscreen-exit'
  | 'paste'
  | 'screen-share-surface';

export type DisplaySurface = 'monitor' | 'window' | 'browser' | 'unknown';

export interface ConsentItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/** The exact list shown on the candidate consent screen. */
export const CONSENT_MANIFEST: readonly ConsentItem[] = [
  {
    id: 'paste',
    label: 'Paste events',
    detail: 'The size of pasted text and the file it was pasted into are logged. The content is never logged.',
  },
  {
    id: 'focus',
    label: 'Window focus',
    detail: 'When this window loses or regains focus, and when the tab becomes hidden or visible, is logged.',
  },
  {
    id: 'fullscreen',
    label: 'Fullscreen changes',
    detail: 'Entering or leaving fullscreen is logged.',
  },
  {
    id: 'screen-share',
    label: 'Screen share type',
    detail: 'If you share your screen, whether you shared a monitor, a window or a browser tab is logged.',
  },
  {
    id: 'replay',
    label: 'Editing replay',
    detail: 'The interviewer can replay what the editor contained and when changes arrived after the session.',
  },
  {
    id: 'limits',
    label: 'What this is',
    detail: 'These signals are evidence for the interviewer to review. They are not tamper-proof and are not an automated verdict.',
  },
];

export interface IntegrityEventInput {
  readonly type: IntegrityEventType;
  readonly path?: string;
  /** Character count only; never the pasted content. */
  readonly size?: number;
  readonly surface?: DisplaySurface;
  /** Accepted for ordering only; the server stamps the stored time. */
  readonly at?: number;
}

export interface IntegrityEvent extends IntegrityEventInput {
  readonly connectionId: string;
  readonly at: number;
}

export interface ReplayUpdate {
  readonly at: number;
  readonly connectionId?: string;
  readonly path: string;
  readonly chars: number;
  readonly insertedChars: number;
  readonly origin: 'candidate' | 'external' | 'unknown';
}

export interface ReplaySnapshot {
  readonly at: number;
  readonly path: string;
  readonly content: string;
}

export interface ReplayTruncation {
  readonly events: boolean;
  readonly updates: boolean;
  readonly snapshots: boolean;
}

export interface InterviewReplay {
  readonly roomId?: string;
  readonly consent: ReadonlyArray<{ connectionId: string; acceptedAt: number }>;
  readonly consentManifest: readonly ConsentItem[];
  readonly events: readonly IntegrityEvent[];
  readonly updates: readonly ReplayUpdate[];
  readonly snapshots: readonly ReplaySnapshot[];
  readonly truncated: ReplayTruncation;
}

export interface InterviewStoreOptions {
  roomId?: string;
  now?: () => number;
  maxEvents?: number;
  maxUpdates?: number;
  maxSnapshots?: number;
  maxSnapshotBytes?: number;
  maxSnapshotTotalBytes?: number;
}

export class InterviewStore {
  private readonly consent = new Map<string, number>();
  private readonly events: IntegrityEvent[] = [];
  private readonly updates: ReplayUpdate[] = [];
  private readonly snapshots: ReplaySnapshot[] = [];
  private snapshotBytes = 0;
  private readonly truncated: { events: boolean; updates: boolean; snapshots: boolean } = {
    events: false,
    updates: false,
    snapshots: false,
  };
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxUpdates: number;
  private readonly maxSnapshots: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxSnapshotTotalBytes: number;

  constructor(private readonly options: InterviewStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxEvents = options.maxEvents ?? MAX_INTEGRITY_EVENTS;
    this.maxUpdates = options.maxUpdates ?? MAX_REPLAY_UPDATES;
    this.maxSnapshots = options.maxSnapshots ?? MAX_REPLAY_SNAPSHOTS;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
    this.maxSnapshotTotalBytes = options.maxSnapshotTotalBytes ?? MAX_SNAPSHOT_TOTAL_BYTES;
  }

  get manifest(): readonly ConsentItem[] {
    return CONSENT_MANIFEST;
  }

  get roomId(): string | undefined {
    return this.options.roomId;
  }

  /** Idempotent: acceptance is recorded once per connection. */
  grantConsent(connectionId: string): boolean {
    if (!connectionId) return false;
    if (this.consent.has(connectionId)) return false;
    this.consent.set(connectionId, this.now());
    return true;
  }

  hasConsent(connectionId: string): boolean {
    return this.consent.has(connectionId);
  }

  /** Store a validated batch; returns how many events were accepted. */
  record(connectionId: string, events: readonly IntegrityEventInput[]): number {
    if (!this.hasConsent(connectionId)) return 0;
    let accepted = 0;
    for (const event of events) {
      const stored: IntegrityEvent = {
        connectionId,
        type: event.type,
        at: this.now(),
        ...(event.path !== undefined ? { path: event.path } : {}),
        ...(event.size !== undefined ? { size: event.size } : {}),
        ...(event.surface !== undefined ? { surface: event.surface } : {}),
      };
      this.events.push(stored);
      accepted += 1;
      if (this.events.length > this.maxEvents) {
        this.events.shift();
        this.truncated.events = true;
      }
    }
    return accepted;
  }

  noteUpdate(update: Omit<ReplayUpdate, 'at'>): void {
    if (update.connectionId && !this.hasConsent(update.connectionId)) return;
    this.updates.push({ ...update, at: this.now() });
    if (this.updates.length > this.maxUpdates) {
      this.updates.shift();
      this.truncated.updates = true;
    }
  }

  captureSnapshot(path: string, content: string): void {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxSnapshotBytes) {
      this.truncated.snapshots = true;
      return;
    }
    const previous = this.snapshots[this.snapshots.length - 1];
    if (previous?.path === path && previous.content === content) return;
    this.snapshots.push({ at: this.now(), path, content });
    this.snapshotBytes += bytes;
    while (
      this.snapshots.length > 1 &&
      (this.snapshots.length > this.maxSnapshots || this.snapshotBytes > this.maxSnapshotTotalBytes)
    ) {
      const removed = this.snapshots.shift();
      if (removed) this.snapshotBytes -= Buffer.byteLength(removed.content, 'utf8');
      this.truncated.snapshots = true;
    }
  }

  replay(): InterviewReplay {
    return {
      ...(this.options.roomId ? { roomId: this.options.roomId } : {}),
      consent: [...this.consent.entries()]
        .map(([connectionId, acceptedAt]) => ({ connectionId, acceptedAt }))
        .sort((left, right) => left.acceptedAt - right.acceptedAt),
      consentManifest: CONSENT_MANIFEST,
      events: this.events.map((event) => ({ ...event })),
      updates: this.updates.map((update) => ({ ...update })),
      snapshots: this.snapshots.map((snapshot) => ({ ...snapshot })),
      truncated: { ...this.truncated },
    };
  }

  clear(): void {
    this.consent.clear();
    this.events.length = 0;
    this.updates.length = 0;
    this.snapshots.length = 0;
    this.snapshotBytes = 0;
    this.truncated.events = false;
    this.truncated.updates = false;
    this.truncated.snapshots = false;
  }

  dispose(): void {
    this.clear();
  }
}
