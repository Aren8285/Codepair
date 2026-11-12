import type { ApiClient, IntegrityEvent, IntegrityEventType } from './api';

type Surface = 'monitor' | 'window' | 'browser' | 'unknown';

/**
 * Candidate-only, client-reported evidence. A modified client can simply stop
 * sending these events; the value is for a candidate using the unmodified app,
 * never an automated or tamper-proof verdict.
 */
export class IntegrityReporter {
  private queue: IntegrityEvent[] = [];
  private timer: number | undefined;
  private stopped = false;

  constructor(
    private readonly api: ApiClient,
    private readonly activePath: () => string | null,
  ) {}

  report(type: IntegrityEventType, extra: Omit<IntegrityEvent, 'type'> = {}): void {
    if (this.stopped) return;
    this.queue.push({ type, ...extra });
    if (this.queue.length >= 10) {
      this.flush();
      return;
    }
    this.timer ??= window.setTimeout(() => this.flush(), 250);
  }

  reportScreenSurface(surface: Surface): void {
    this.report('screen-share-surface', { surface });
  }

  flush(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, 100);
    void this.api.reportIntegrity(batch).catch(() => {
      // Evidence is best-effort; a failed batch must not break the workspace.
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private path(): string | undefined {
    return this.activePath() ?? undefined;
  }

  private onPaste = (event: ClipboardEvent): void => {
    const size = event.clipboardData?.getData('text')?.length ?? 0;
    this.report('paste', { size, ...(this.path() ? { path: this.path() } : {}) });
  };

  private onVisibility = (): void => {
    this.report('visibility');
  };

  private onBlur = (): void => {
    this.report('blur');
  };

  private onFocus = (): void => {
    this.report('focus');
  };

  private onFullscreen = (): void => {
    this.report(document.fullscreenElement ? 'fullscreen-enter' : 'fullscreen-exit');
  };

  attach(): void {
    document.addEventListener('paste', this.onPaste, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('fullscreenchange', this.onFullscreen);
  }

  detach(): void {
    document.removeEventListener('paste', this.onPaste, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
  }
}
