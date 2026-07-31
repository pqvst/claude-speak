// Spoken announcements for AskUserQuestion blocks. The session is blocked
// until you answer, so this is the one moment where silence is actively
// costly. Options are numbered so they can be referred back to by ear.

import { speechify } from './speechify.ts';

// Terminal punctuation makes `say` pause between question, label, description.
function sentence(text: unknown): string {
  const t = String(text || '').trim();
  if (!t) return '';
  return /[.!?:]$/.test(t) ? t : `${t}.`;
}

interface QuestionOption {
  label?: string;
  description?: string;
}

interface Question {
  question?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export function questionAnnouncement(input: { questions?: Question[] } | undefined): string {
  const questions = input?.questions;
  const parts: string[] = [];
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!q?.question) continue;
    const options = (Array.isArray(q.options) ? q.options : []).filter(
      (o) => o && (o.label || o.description)
    );
    let part = sentence(q.question);
    if (options.length && q.multiSelect) part += ' Choose any that apply.';
    options.forEach((o, i) => {
      part += ` Option ${i + 1}. ${sentence(o.label)} ${sentence(o.description)}`;
    });
    parts.push(part);
  }
  return speechify(parts.join(' '));
}
