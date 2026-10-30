import { NOT_TEXT_MESSAGE } from "./binary-file";

export interface FriendlyError { message: string; detail?: string }

const rules: { test: RegExp; message: string }[] = [
  { test: /stream did not contain valid UTF-8|isn't text, so it can't be opened|invalid utf-?8/i, message: NOT_TEXT_MESSAGE },
  { test: /no space left on device|os error 28|\bENOSPC\b|disk quota exceeded|os error 122/i, message: "The disk is full, so span could not save. Free some space and try again. Your edits are still open in the editor." },
  { test: /permission denied|os error 13|\bEACCES\b|operation not permitted|os error 1\b/i, message: "span does not have permission to write there. Check the folder permissions and try again." },
  { test: /read-only file system|os error 30|\bEROFS\b/i, message: "That location is read-only, so span could not save there." },
  { test: /file name too long|os error 63|os error 36/i, message: "That file name is too long." },
];

/** Turns a raw operating system error into a plain sentence and keeps the original text as detail. */
export function friendlyError(raw: string): FriendlyError {
  const text = raw.trim();
  const rule = rules.find(item => item.test.test(text));
  return rule ? (text === rule.message ? { message: text } : { message: rule.message, detail: text }) : { message: text };
}
