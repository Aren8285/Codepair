import { baseName, defaultExtensionForLanguage, extensionOf, languageForPath } from './language';

export function fileNameForExport(path: string): string {
  const name = baseName(path) || 'untitled';
  return extensionOf(name) ? name : `${name}.${defaultExtensionForLanguage(languageForPath(path))}`;
}

export function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportEditorFile(path: string, content: string): string {
  const fileName = fileNameForExport(path);
  downloadTextFile(fileName, content);
  return fileName;
}
