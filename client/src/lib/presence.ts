export interface LocalIdentity {
  name: string;
  color: string;
}

const COLORS = ['#7c8cf8', '#f2b880', '#6fd08c', '#e59ad8', '#76c7e8', '#f28f8f', '#c8a2ff', '#ffd166'];
const STORAGE_KEY = 'codepair.identity';

function randomName(): string {
  const adjectives = ['Swift', 'Quiet', 'Bright', 'Clever', 'Calm', 'Bold', 'Kind', 'Sharp'];
  const nouns = ['Otter', 'Falcon', 'Cedar', 'Harbor', 'Comet', 'Willow', 'Pine', 'Ember'];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)] ?? 'Quiet';
  const noun = nouns[Math.floor(Math.random() * nouns.length)] ?? 'Otter';
  return `${adjective} ${noun}`;
}

/**
 * Identity lives in sessionStorage so two tabs in the same browser are
 * distinct collaborators (localStorage would make both tabs look identical).
 */
export function currentPresence(): LocalIdentity {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalIdentity>;
      if (typeof parsed.name === 'string' && parsed.name.trim() && /^#[0-9a-f]{6}$/i.test(parsed.color ?? '')) {
        return { name: parsed.name.slice(0, 40), color: parsed.color! };
      }
    }
  } catch {
    // Corrupt storage falls back to a fresh identity.
  }
  const identity: LocalIdentity = {
    name: randomName(),
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#7c8cf8',
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Storage can be unavailable in private modes; identity is still usable.
  }
  return identity;
}
