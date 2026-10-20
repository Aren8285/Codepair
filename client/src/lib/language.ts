const EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  xml: 'xml',
  svg: 'xml',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
};

const FILENAMES: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  '.gitignore': 'plaintext',
  '.env': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
};

const DEFAULT_EXTENSION: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  csharp: 'cs',
  go: 'go',
  rust: 'rs',
  ruby: 'rb',
  php: 'php',
  kotlin: 'kt',
  swift: 'swift',
  shell: 'sh',
  sql: 'sql',
  json: 'json',
  markdown: 'md',
  html: 'html',
  css: 'css',
  yaml: 'yml',
  plaintext: 'txt',
};

export function languageForPath(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath;
  if (FILENAMES[name]) return FILENAMES[name];
  if (name.startsWith('Dockerfile')) return 'dockerfile';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return EXTENSIONS[extension] ?? 'plaintext';
}

export function languageLabel(language: string): string {
  switch (language) {
    case 'typescript':
      return 'TypeScript';
    case 'javascript':
      return 'JavaScript';
    case 'cpp':
      return 'C++';
    case 'plaintext':
      return 'Plain text';
    default:
      return language.charAt(0).toUpperCase() + language.slice(1);
  }
}

export function defaultExtensionForLanguage(language: string): string {
  return DEFAULT_EXTENSION[language] ?? 'txt';
}

export function parentDirectory(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

export function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

export function extensionOf(filePath: string): string {
  const name = baseName(filePath);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}
