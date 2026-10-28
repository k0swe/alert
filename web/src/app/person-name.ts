const ROMAN_SUFFIX = /^(?:II|III|IV|V|VI|VII|VIII|IX|X)$/i;
const GENERATIONAL_SUFFIX = /^(?:JR|SR)$/i;
const ACADEMIC_SUFFIX = /^(?:PHD|MD|DDS|DVM|ESQ)$/i;

/**
 * Normalize database-style names while preserving capitalization that a person has already set.
 *
 * This intentionally changes only individual words that contain no lowercase letters. Correct
 * personal-name capitalization is not fully inferable, so mixed-case words such as "deGrasse" and
 * quoted nicknames such as "Noel" remain untouched while surrounding all-caps words are fixed.
 */
export function normalizePersonName(value: string): string {
  const normalizedWhitespace = value.trim().replace(/\s+/g, ' ');
  if (!normalizedWhitespace) {
    return normalizedWhitespace;
  }

  return normalizedWhitespace
    .split(' ')
    .map((word) => normalizeWord(word))
    .join(' ');
}

function normalizeWord(word: string): string {
  const { leading, core, trailing } = splitOuterPunctuation(word);
  if (!core || /\p{Ll}/u.test(core)) {
    return word;
  }

  const bareSuffix = core.replace(/\./g, '');
  if (ROMAN_SUFFIX.test(bareSuffix)) {
    return `${leading}${bareSuffix.toUpperCase()}${trailing}`;
  }
  if (GENERATIONAL_SUFFIX.test(bareSuffix)) {
    const suffix = `${titleLetters(bareSuffix.toLocaleLowerCase('en-US'))}${core.endsWith('.') ? '.' : ''}`;
    return `${leading}${suffix}${trailing}`;
  }
  if (ACADEMIC_SUFFIX.test(bareSuffix)) {
    const suffix = `${bareSuffix.toUpperCase()}${core.endsWith('.') ? '.' : ''}`;
    return `${leading}${suffix}${trailing}`;
  }
  if (/^(?:\p{L}\.)+$/u.test(core) || /^\p{L}$/u.test(core)) {
    return `${leading}${core.toUpperCase()}${trailing}`;
  }

  const normalized = core
    .toLocaleLowerCase('en-US')
    .split(/([-’'])/u)
    .map((part) => (/^[-’']$/u.test(part) ? part : normalizeNamePart(part)))
    .join('');
  return `${leading}${normalized}${trailing}`;
}

function normalizeNamePart(part: string): string {
  if (!part) {
    return part;
  }

  const titled = titleLetters(part);
  if (/^mc\p{L}{2,}$/u.test(part)) {
    return `Mc${uppercaseAt(part.slice(2), 0)}`;
  }

  // Common Scottish/Irish prefix. Avoid short words such as Mack and Macy.
  if (/^mac\p{L}{3,}$/u.test(part) && !/^mac(?:ias|hado|hin|kie|key|klin|quarie)$/u.test(part)) {
    return `Mac${uppercaseAt(part.slice(3), 0)}`;
  }

  return titled;
}

function titleLetters(value: string): string {
  const firstLetter = value.search(/\p{L}/u);
  return firstLetter < 0 ? value : uppercaseAt(value, firstLetter);
}

function uppercaseAt(value: string, index: number): string {
  return `${value.slice(0, index)}${value.charAt(index).toLocaleUpperCase('en-US')}${value.slice(index + 1)}`;
}

function splitOuterPunctuation(word: string): {
  leading: string;
  core: string;
  trailing: string;
} {
  const match = word.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}.]*)$/u);
  return match
    ? { leading: match[1], core: match[2], trailing: match[3] }
    : { leading: '', core: word, trailing: '' };
}
