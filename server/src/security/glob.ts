/**
 * Glob matching for the path access policy.
 *
 * Patterns are compiled once (at policy construction) into token lists, so a
 * request only pays for matching. The matcher is iterative: it advances through
 * the path once and remembers a single backtrack point for the most recent
 * wildcard. That keeps the cost proportional to (pattern × path) with no nested
 * quantifiers, so a hostile pattern like `a*a*a*a*a*a*a*b` cannot blow up.
 *
 * Semantics (see README):
 *  - `*`   any run of characters except `/`, including an empty run and a leading dot
 *  - `**`  any run of characters, `/` included
 *  - `?`   exactly one character except `/`
 *  - no `/` in the pattern: match the basename at any depth
 *  - a pattern containing `/` is anchored at the project root
 *  - `dir/**` covers `dir` itself as well as everything beneath it
 */

/** NFC + case folding for every comparison (macOS may hand us NFD names). */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/**
 * Normalised project-relative form used for matching. PathGuard already strips
 * `.`, doubled and trailing separators; doing it again here means a policy rule
 * cannot be dodged by a caller that hands us a less tidy string.
 */
export function normalizePathForMatch(value: string): string {
  return normalizeForMatch(value)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

export interface CompiledGlob {
  /** True when the pattern contains `/` and therefore matches from the root. */
  readonly anchored: boolean;
  readonly pattern: string;
  match(path: string): boolean;
}

type Token =
  | { type: 'literal'; value: string }
  | { type: 'star' }
  | { type: 'globstar' }
  | { type: 'qmark' };

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) {
      tokens.push({ type: 'literal', value: literal });
      literal = '';
    }
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        flush();
        tokens.push({ type: 'globstar' });
        index += 1;
      } else {
        flush();
        tokens.push({ type: 'star' });
      }
    } else if (character === '?') {
      flush();
      tokens.push({ type: 'qmark' });
    } else {
      literal += character;
    }
  }
  flush();
  return tokens;
}

function matchTokens(tokens: readonly Token[], text: string): boolean {
  let textIndex = 0;
  let tokenIndex = 0;
  let starToken = -1;
  let starText = 0;
  let starCrossesSlash = false;

  while (textIndex < text.length) {
    const token = tokens[tokenIndex];
    if (token?.type === 'literal' && text.startsWith(token.value, textIndex)) {
      textIndex += token.value.length;
      tokenIndex += 1;
      continue;
    }
    if (token?.type === 'qmark' && text[textIndex] !== '/') {
      textIndex += 1;
      tokenIndex += 1;
      continue;
    }
    if (token?.type === 'star' || token?.type === 'globstar') {
      starToken = tokenIndex;
      starText = textIndex;
      starCrossesSlash = token.type === 'globstar';
      tokenIndex += 1;
      continue;
    }
    if (starToken === -1) return false;
    // Backtrack the last wildcard by one character. `*` may not swallow `/`.
    if (!starCrossesSlash && text[starText] === '/') return false;
    starText += 1;
    textIndex = starText;
    tokenIndex = starToken + 1;
  }

  while (tokens[tokenIndex]?.type === 'star' || tokens[tokenIndex]?.type === 'globstar') tokenIndex += 1;
  return tokenIndex === tokens.length;
}

export function compileGlob(rawPattern: string): CompiledGlob {
  const pattern = normalizePathForMatch(rawPattern);
  const anchored = pattern.includes('/');
  const variants: Token[][] = [tokenize(pattern)];
  // `dir/**` also covers `dir` itself, not just everything beneath it.
  if (pattern.endsWith('/**') && !pattern.slice(0, -3).includes('**')) {
    variants.push(tokenize(pattern.slice(0, -3)));
  }

  return {
    anchored,
    pattern,
    match(path: string): boolean {
      const normalized = normalizePathForMatch(path);
      const candidate = anchored ? normalized : normalized.slice(normalized.lastIndexOf('/') + 1);
      return variants.some((tokens) => matchTokens(tokens, candidate));
    },
  };
}
