declare module 'y-monaco' {
  import type * as Y from 'yjs';
  import type * as monaco from 'monaco-editor';

  export class MonacoBinding {
    constructor(
      ytext: Y.Text,
      model: monaco.editor.ITextModel,
      editors?: Set<monaco.editor.IStandaloneCodeEditor>,
      awareness?: unknown,
    );
    destroy(): void;
  }
}
