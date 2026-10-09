// The kinds of thing that can go on a form, as the builder offers them: what
// each one is called, which group it belongs to, and what a new one starts as.
// The rules themselves live in src/gate/forms/items.ts, which checks everything again.
import {
  AlignLeft, AtSign, Baseline, CalendarDays, Check, CircleDot, Clock, Eye, Hash, Heading, Home, Image, Link2, ListChecks,
  ListOrdered, Minus, Phone, SlidersHorizontal, Star, Text, User, type LucideIcon,
} from 'lucide-react';
import type { FormItem, ItemType } from './types';

export type ItemKind = { type: ItemType; label: string; hint: string; icon: LucideIcon; group: string };

export const ITEM_GROUPS = ['Text', 'Choices', 'Dates and numbers', 'People', 'Layout', 'Other'] as const;

export const ITEM_KINDS: ItemKind[] = [
  { type: 'short-text', label: 'Short answer', hint: 'One line of writing', icon: Baseline, group: 'Text' },
  { type: 'long-text', label: 'Long answer', hint: 'A message, several lines', icon: AlignLeft, group: 'Text' },
  { type: 'email', label: 'Email address', hint: 'Checked as they type', icon: AtSign, group: 'Text' },
  { type: 'phone', label: 'Phone number', hint: 'Digits and spaces', icon: Phone, group: 'Text' },
  { type: 'website', label: 'Website address', hint: 'A link to their page', icon: Link2, group: 'Text' },
  { type: 'dropdown', label: 'Drop-down list', hint: 'Pick one from a list', icon: ListOrdered, group: 'Choices' },
  { type: 'single-choice', label: 'One choice', hint: 'Buttons, pick one', icon: CircleDot, group: 'Choices' },
  { type: 'multiple-choice', label: 'Several choices', hint: 'Tick as many as they like', icon: ListChecks, group: 'Choices' },
  { type: 'checkbox', label: 'Tick box', hint: 'One box, e.g. "I agree"', icon: Check, group: 'Choices' },
  { type: 'number', label: 'Number', hint: 'How many, how much', icon: Hash, group: 'Dates and numbers' },
  { type: 'date', label: 'Date', hint: 'A day from a calendar', icon: CalendarDays, group: 'Dates and numbers' },
  { type: 'time', label: 'Time', hint: 'A time of day', icon: Clock, group: 'Dates and numbers' },
  { type: 'rating', label: 'Stars', hint: 'A rating out of five', icon: Star, group: 'Dates and numbers' },
  { type: 'scale', label: 'Scale', hint: 'A row of numbers to pick from', icon: SlidersHorizontal, group: 'Dates and numbers' },
  { type: 'name', label: 'Name', hint: 'First and last name', icon: User, group: 'People' },
  { type: 'address', label: 'Address', hint: 'Street, town, postcode', icon: Home, group: 'People' },
  { type: 'heading', label: 'Heading', hint: 'A few words to break it up', icon: Heading, group: 'Layout' },
  { type: 'paragraph', label: 'Paragraph', hint: 'Something to read', icon: Text, group: 'Layout' },
  { type: 'divider', label: 'Line', hint: 'A line across the form', icon: Minus, group: 'Layout' },
  { type: 'image', label: 'Picture', hint: 'From one of your media folders', icon: Image, group: 'Layout' },
  { type: 'hidden', label: 'Hidden answer', hint: "Filled in for them; they don't see it", icon: Eye, group: 'Other' },
];

export const kindOf = (type: ItemType): ItemKind =>
  ITEM_KINDS.find((k) => k.type === type) ?? { type, label: type, hint: '', icon: Baseline, group: 'Other' };

let nextNew = 0;
// A brand-new item, before the server has seen it: its id starts with "new" so
// the server gives it a real one (and its key) when the form is saved.
export function newItem(type: ItemType): FormItem {
  const id = `new-${++nextNew}`;
  const base: FormItem = { id, type, width: 'full' };
  switch (type) {
    case 'heading': return { ...base, text: 'A heading', size: 'medium' };
    case 'paragraph': return { ...base, text: 'Something to read.' };
    case 'divider': return base;
    case 'image': return { ...base, src: '', alt: '' };
    case 'dropdown':
    case 'single-choice':
    case 'multiple-choice': return { ...base, label: kindOf(type).label, options: ['First choice', 'Second choice'], required: false, columns: 1 };
    case 'checkbox': return { ...base, label: 'I agree', required: false };
    case 'name': return { ...base, label: 'Your name', required: false, parts: { title: false, middle: false } };
    case 'address': return { ...base, label: 'Address', required: false, parts: { line2: true, region: true, postcode: true, country: true } };
    case 'rating': return { ...base, label: 'How was it?', required: false, stars: 5 };
    case 'scale': return { ...base, label: 'Out of ten', required: false, from: 1, to: 10, lowLabel: '', highLabel: '' };
    case 'hidden': return { ...base, label: 'Where they came from', param: '', value: '' };
    case 'long-text': return { ...base, label: 'Message', required: false, rows: 5 };
    default: return { ...base, label: kindOf(type).label, required: false };
  }
}

// What the panel shows on a form's card and in the Responses list.
export const answerText = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return Object.values(value as Record<string, string>).filter(Boolean).join(', ');
  return String(value);
};
