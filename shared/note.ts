// The manager's own notebook line: "/note <text>" typed in the command bar goes to the lab notebook
// instead of to an employee. Shared so the browser and the tests agree on what counts.

/** The note in "/note <text>", or null when the input is not that command. An empty note is ''. */
export function noteCommand(input: string): string | null {
  const m = input.trim().match(/^\/note(?:\s+([\s\S]*))?$/i);
  return m ? (m[1] ?? '').trim() : null;
}
