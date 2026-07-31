// Markdown to speech. Structures that carry no meaning when read aloud get
// described instead of recited: a ten-row table read verbatim is a solid
// minute of "pipe, eleven M B, pipe".

function listPhrase(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const isTableRow = (line: string): boolean => /^\s*\|/.test(line);
const isTableRule = (line: string): boolean => /^\s*\|[\s:|-]*$/.test(line) && line.includes('-');

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.replace(/[`*_]/g, '').trim())
    .filter(Boolean);
}

// "| Size | File |" + 10 rows -> "a table with columns Size and File, and 10 rows."
function summarizeTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTableRow(lines[i]) || !isTableRule(lines[i + 1] || '')) {
      out.push(lines[i]);
      continue;
    }
    const columns = cells(lines[i]);
    let end = i + 2;
    while (end < lines.length && isTableRow(lines[end])) end++;
    const rows = end - i - 2;
    const rowPhrase = `${rows} ${rows === 1 ? 'row' : 'rows'}`;
    // Trailing period so `say` pauses before whatever follows the table.
    out.push(
      columns.length
        ? `a table with columns ${listPhrase(columns)}, and ${rowPhrase}.`
        : `a table with ${rowPhrase}.`
    );
    i = end - 1;
  }
  return out.join('\n');
}

export function speechify(markdown: unknown): string {
  let text = String(markdown || '');
  text = text.replace(/```([^\n`]*)\n[\s\S]*?```/g, (_, lang: string) => {
    const name = lang.trim().split(/\s+/)[0];
    return name ? `\na ${name} code block.\n` : '\na code block.\n';
  });
  // A fence left unclosed by a cut-off message.
  text = text.replace(/```[\s\S]*$/, '\na code block.\n');
  text = summarizeTables(text);
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, '') // horizontal rules
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered items
    .replace(/`+/g, '') // inline code
    .replace(/~~/g, '') // strikethrough
    .replace(/\*/g, '') // bold and italic markers
    .replace(/&/g, ' and ') // "dead-code & assets" reads as a pause otherwise
    .replace(/~(?=\d)/g, 'about ') // "~134 images" -> "about 134 images"
    .replace(/\s+/g, ' ')
    .trim();
}
