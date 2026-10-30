/**
 * Files that never open in the text editor. Rust is authoritative (crates/core/src/text_file.rs refuses binary
 * content with one message); this module only spares a round trip for known extensions and recognises that message.
 */
import { extensionOf } from './file-extension';

/** The single user facing sentence, identical to `NOT_TEXT_MESSAGE` in span-core. */
export const NOT_TEXT_MESSAGE = "This file isn't text, so it can't be opened in the editor.";

/** Mirrors the span-core extension list. SVG and other XML formats are text and stay out. */
const binaryExtensions = new Set([
  'docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xltx', 'pptx', 'pptm', 'potx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'numbers', 'pages', 'pdf', 'epub',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'apk', 'ipa', 'dmg', 'iso', 'pkg', 'deb', 'rpm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'heic', 'avif', 'psd', 'sketch', 'fig',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'class', 'wasm', 'pyc', 'sqlite', 'sqlite3', 'db', 'bin',
]);

export const isKnownBinaryPath = (path: string) => binaryExtensions.has(extensionOf(path.split('/').pop() || path));

/** Raw text of the Rust `read_to_string` UTF-8 failure and of the typed refusal. */
const notTextPattern = /isn't text, so it can't be opened|stream did not contain valid UTF-8|invalid utf-?8/i;

export function isNotTextError(error: unknown): boolean {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return notTextPattern.test(text);
}
