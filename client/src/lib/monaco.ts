import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Bundled locally: the editor must work on a LAN with no internet access.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });

monaco.editor.defineTheme('codepair', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '67768a', fontStyle: 'italic' },
    { token: 'keyword', foreground: '9b8cff' },
    { token: 'string', foreground: 'a8d8a0' },
    { token: 'number', foreground: 'f2b880' },
    { token: 'type', foreground: '76c7e8' },
    { token: 'function', foreground: 'e6c07b' },
    { token: 'variable', foreground: 'dbe3ee' },
  ],
  colors: {
    'editor.background': '#0b131c',
    'editor.foreground': '#dbe3ee',
    'editorLineNumber.foreground': '#3c4a5c',
    'editorLineNumber.activeForeground': '#9fb0c6',
    'editorCursor.foreground': '#7c8cf8',
    'editor.selectionBackground': '#283b56',
    'editor.inactiveSelectionBackground': '#1d2c40',
    'editor.lineHighlightBackground': '#0f1a26',
    'editorIndentGuide.background1': '#182534',
    'editorIndentGuide.activeBackground1': '#2a3d52',
    'editorWidget.background': '#0d1722',
    'editorWidget.border': '#1d2c3d',
    'editorSuggestWidget.background': '#0d1722',
    'editorSuggestWidget.selectedBackground': '#1a2a3d',
    'editorHoverWidget.background': '#0d1722',
    'editorBracketMatch.background': '#1d2c40',
    'editorBracketMatch.border': '#4a6182',
    'scrollbarSlider.background': '#1e2c3c88',
    'scrollbarSlider.hoverBackground': '#2c405688',
    'minimap.background': '#0b131c',
  },
});

const compilerOptions = {
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  allowJs: true,
  checkJs: false,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  allowNonTsExtensions: true,
  esModuleInterop: true,
};

monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
// Show syntax/semantic diagnostics but ignore "unused" noise for a scratch IDE.
const diagnostics = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [6133, 6192, 6196, 80001],
};
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics);
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics);

export const MONACO_THEME = 'codepair';
export { monaco };
