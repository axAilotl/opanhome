export function takeFlushChunk(
  input: string,
  options: {
    hasStarted: boolean;
    firstWords?: number;
    firstChars?: number;
    softLimit?: number;
    hardLimit?: number;
  },
): { flushText: string | null; remainder: string } {
  const firstWords = options.firstWords ?? 2;
  const firstChars = options.firstChars ?? 18;
  const softLimit = options.softLimit ?? 64;
  const hardLimit = options.hardLimit ?? 120;

  if (!input) {
    return { flushText: null, remainder: input };
  }

  let boundary = sentenceBoundary(input);
  const trailingBoundary = trailingWhitespaceBoundary(input);
  if (
    boundary === null &&
    trailingBoundary !== null &&
    !options.hasStarted &&
    shouldStartPlayback(input, firstWords, firstChars)
  ) {
    boundary = trailingBoundary;
  }
  if (boundary === null && trailingBoundary !== null && input.trim().length >= softLimit) {
    boundary = trailingBoundary;
  }
  if (boundary === null && input.trim().length >= hardLimit) {
    boundary = input.length;
  }
  if (boundary === null) {
    return { flushText: null, remainder: input };
  }

  const flushText = input.slice(0, boundary).trim();
  const remainder = input.slice(boundary).trimStart();
  return { flushText: flushText || null, remainder };
}

export function sanitizeSpokenText(input: string): string {
  return input
    .replace(/\*{1,2}[^*]+\*{1,2}/g, " ")
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "")
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "")
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "")
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "")
    .replace(/ :\)/gu, " ")
    .replace(/ :D/gu, " ")
    .replace(/^:\)/gu, "")
    .replace(/^:D/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sentenceBoundary(input: string): number | null {
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!char || !".?!\n".includes(char)) {
      continue;
    }
    const next = input[index + 1];
    if (next === undefined || /\s/.test(next)) {
      return index + 1;
    }
  }
  return null;
}

function trailingWhitespaceBoundary(input: string): number | null {
  if (!input || !/\s/.test(input[input.length - 1] ?? "")) {
    return null;
  }
  return input.length;
}

function shouldStartPlayback(input: string, firstWords: number, firstChars: number): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length >= firstChars) {
    return true;
  }
  return trimmed.split(/\s+/).length >= firstWords;
}
