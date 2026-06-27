const TOXIC_TERM_WEIGHTS = {
  abuse: 2,
  abusive: 2,
  awful: 1,
  clown: 1,
  creep: 2,
  creeps: 2,
  cruel: 2,
  degenerate: 3,
  disgusting: 2,
  dumb: 2,
  idiot: 3,
  idiots: 3,
  idiotic: 3,
  loser: 2,
  losers: 2,
  moron: 3,
  morons: 3,
  pathetic: 2,
  psycho: 3,
  scum: 3,
  stupid: 2,
  trash: 1,
  worthless: 3,
  'drop dead': 5,
  'go to hell': 4,
  'kill yourself': 6,
  'nobody likes you': 4,
  'shut up': 2,
  'you are disgusting': 4,
  'you are pathetic': 4,
  'you are stupid': 4,
  'you are trash': 4,
  'you are worthless': 5,
  'you are the worst': 4,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function tokenize(text) {
  return text.match(/[a-z']+/g) || [];
}

function buildMatcher(termWeights) {
  const unigram = new Map();
  const phraseRoot = new Map();

  for (const [term, weight] of Object.entries(termWeights)) {
    const parts = tokenize(term);
    if (parts.length === 0) {
      continue;
    }

    if (parts.length === 1) {
      unigram.set(parts[0], weight);
      continue;
    }

    let node = phraseRoot;
    for (const part of parts) {
      if (!node.has(part)) {
        node.set(part, { next: new Map(), term: null, weight: 0, length: 0 });
      }
      node = node.get(part).next;
    }

    // Walk again to write terminal metadata without storing parent pointers.
    let writeNode = phraseRoot;
    for (let i = 0; i < parts.length; i += 1) {
      const key = parts[i];
      const entry = writeNode.get(key);
      if (i === parts.length - 1) {
        entry.term = term;
        entry.weight = weight;
        entry.length = parts.length;
      }
      writeNode = entry.next;
    }
  }

  return { unigram, phraseRoot };
}

const MATCHER = buildMatcher(TOXIC_TERM_WEIGHTS);

function incrementCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

export function analyzeToxicity(inputText = '') {
  const text = normalizeText(inputText);
  const words = tokenize(text);
  const wordCount = words.length;
  const detectedCounts = new Map();

  let toxicWordCount = 0;
  let severityTotal = 0;

  // Single-token toxic words.
  for (const word of words) {
    const weight = MATCHER.unigram.get(word);
    if (!weight) {
      continue;
    }

    toxicWordCount += 1;
    severityTotal += weight;
    incrementCount(detectedCounts, word, 1);
  }

  // Multi-word toxic phrases via trie traversal.
  for (let start = 0; start < words.length; start += 1) {
    const firstEntry = MATCHER.phraseRoot.get(words[start]);
    if (!firstEntry) {
      continue;
    }

    let currentEntry = firstEntry;
    let index = start + 1;

    if (currentEntry.term) {
      toxicWordCount += currentEntry.length;
      severityTotal += currentEntry.weight;
      incrementCount(detectedCounts, currentEntry.term, 1);
    }

    while (index < words.length) {
      const nextEntry = currentEntry.next.get(words[index]);
      if (!nextEntry) {
        break;
      }

      currentEntry = nextEntry;
      if (currentEntry.term) {
        toxicWordCount += currentEntry.length;
        severityTotal += currentEntry.weight;
        incrementCount(detectedCounts, currentEntry.term, 1);
      }
      index += 1;
    }
  }

  const termRate = wordCount > 0 ? (toxicWordCount / wordCount) * 100 : 0;
  const severityRate = wordCount > 0 ? (severityTotal / wordCount) * 100 : 0;
  const rawScore = termRate * 1.4 + severityRate * 2.1 + Math.min(30, toxicWordCount * 0.35);

  return {
    toxicityScore: clamp(Math.round(rawScore), 0, 100),
    toxicWordCount,
    detectedWords: Array.from(detectedCounts.keys()),
  };
}

export default analyzeToxicity;
