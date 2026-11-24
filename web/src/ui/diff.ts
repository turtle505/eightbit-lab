/** A line of a diff: ' ' unchanged, '-' removed, '+' added, '…' a run of unchanged lines left out. */
export interface DiffLine {
  op: ' ' | '-' | '+' | '…';
  text: string;
}

const MAX_LINES = 400;
const CONTEXT = 3;

/** Line diff by longest common subsequence; big inputs skip the LCS and show old then new. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length > MAX_LINES || B.length > MAX_LINES)
    return [...A.map((text) => ({ op: '-' as const, text })), ...B.map((text) => ({ op: '+' as const, text }))];
  // lcs[i][j] = LCS length of A[i..] and B[j..]
  const lcs = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      out.push({ op: ' ', text: A[i] });
      i++;
      j++;
    } else if (i < A.length && (j >= B.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: '-', text: A[i++] }); // removals first, like git
    else out.push({ op: '+', text: B[j++] });
  }
  return collapse(out);
}

/** Keep CONTEXT unchanged lines around each change; longer unchanged runs become one '…' row. */
function collapse(lines: DiffLine[]): DiffLine[] {
  const near = lines.map(() => false);
  lines.forEach((l, k) => {
    if (l.op === ' ') return;
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (lines[k + d]) near[k + d] = true;
  });
  if (!near.some(Boolean)) return lines.length > CONTEXT * 2 ? [...lines.slice(0, CONTEXT), { op: '…', text: '' }] : lines;
  const out: DiffLine[] = [];
  lines.forEach((l, k) => {
    if (near[k]) out.push(l);
    else if (out[out.length - 1]?.op !== '…') out.push({ op: '…', text: '' });
  });
  return out;
}
