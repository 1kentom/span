import { describe, expect, it } from 'vitest';
import { createPreviewSettings } from './preview-settings';

describe('browser scoped settings fixture', () => {
  it('keeps scope overrides separate and inherits reset workspace values', () => {
    const fixture = createPreviewSettings();
    fixture.update('user', 'fontSize', '17');
    fixture.update('workspace', 'fontSize', '21');
    expect(fixture.get('user').fontSize).toBe(17);
    expect(fixture.get().fontSize).toBe(21);
    fixture.update('workspace', 'editor.fontSize', null);
    expect(fixture.get().fontSize).toBe(17);
    expect(fixture.keys('workspace')).toEqual([]);
  });

  it('preserves comments and unknown keys while replacing competing aliases', () => {
    const fixture = createPreviewSettings();
    fixture.updateJsonc('user', '// retained comment\n{"fontSize":12,"editor.fontSize":19,"future.option":true,}');
    expect(fixture.get().fontSize).toBe(19);
    fixture.update('user', 'fontSize', '15');
    expect(fixture.raw('user')).toContain('// retained comment');
    expect(fixture.raw('user')).toMatch(/"future.option"\s*:\s*true/);
    expect(fixture.raw('user')).not.toContain('editor.fontSize');
    expect(fixture.get().fontSize).toBe(15);
    expect(fixture.get()).not.toHaveProperty('future.option');
    expect(fixture.keys('user')).toEqual(['fontSize']);
  });

  it('merges keybindings by command without moving inherited user entries', () => {
    const fixture = createPreviewSettings();
    fixture.update('user', 'keybindings', '{"quickOpen":["Mod+O"]}');
    fixture.update('workspace', 'keybindings', '{"save":[]}');
    expect(fixture.get().keybindings).toEqual({ quickOpen: ['Mod+O'], save: [] });
    fixture.update('workspace', 'keybindings', null);
    expect(fixture.get().keybindings).toEqual({ quickOpen: ['Mod+O'] });
    expect(fixture.raw('workspace')).not.toContain('quickOpen');
  });

  it('retains invalid editor drafts and effective settings after failed save', () => {
    const fixture = createPreviewSettings();
    const initial = fixture.open('workspace');
    const text = '// must remain editable\n{"editor.fontSize":999,}';
    fixture.edit('workspace', initial.revision, [{ from: 0, to: initial.text.length, insert: text }]);
    expect(() => fixture.save('workspace', 1)).toThrow('supported range');
    expect(fixture.open('workspace')).toMatchObject({ text, revision: 1, savedRevision: 0 });
    expect(fixture.get().fontSize).toBe(13);
    expect(fixture.discard('workspace')).toMatchObject({ text: initial.text, revision: 2, savedRevision: 2 });
    expect(() => fixture.edit('workspace', 1, [])).toThrow('current revision is 2');
  });

  it('commits valid JSONC source only after save and supports exact net-zero drafts', () => {
    const fixture = createPreviewSettings();
    const initial = fixture.open('user');
    const text = '// valid source\n{"files.autoSave":"afterDelay","files.autoSaveDelay":200,}';
    fixture.edit('user', 0, [{ from: 0, to: initial.text.length, insert: text }]);
    expect(fixture.get().autoSave).toBe('off');
    expect(fixture.save('user', 1).savedRevision).toBe(1);
    expect(fixture.get()).toMatchObject({ autoSave: 'afterDelay', autoSaveDelay: 200 });
    fixture.edit('user', 1, [{ from: 0, to: 0, insert: ' ' }]);
    expect(fixture.edit('user', 2, [{ from: 0, to: 1, insert: '' }]).savedRevision).toBe(3);
    expect(() => fixture.updateJsonc('workspace', '{ broken')).toThrow('Invalid settings JSONC');
    expect(() => fixture.updateJsonc('workspace', '{"keybindings":{"unknown":[]}}')).toThrow();
    expect(() => fixture.updateJsonc('workspace', '{"editor.wordWrap":"bounded"}')).toThrow();
  });
});

describe('agent delegation in the browser fixture', () => {
  it('is on by default and only the user scope can turn it off', () => {
    const fixture = createPreviewSettings();
    expect(fixture.get().agents?.delegation?.enabled).toBe(true);
    fixture.update('workspace', 'agents', JSON.stringify({ delegation: { enabled: false } }));
    expect(fixture.get().agents?.delegation?.enabled).toBe(true);
    fixture.update('user', 'agents', JSON.stringify({ delegation: { enabled: false } }));
    expect(fixture.get().agents?.delegation?.enabled).toBe(false);
    expect(fixture.get('user').agents?.delegation?.enabled).toBe(false);
    fixture.update('workspace', 'agents', JSON.stringify({ delegation: { enabled: true } }));
    expect(fixture.get().agents?.delegation?.enabled).toBe(false);
  });
});

describe('agent warm start in the browser fixture', () => {
  it('is on by default and only the user scope can turn it off', () => {
    const fixture = createPreviewSettings();
    expect(fixture.get().agents?.warmStart).toBe(true);
    fixture.update('workspace', 'agents', JSON.stringify({ warmStart: false }));
    expect(fixture.get().agents?.warmStart).toBe(true);
    fixture.update('user', 'agents', JSON.stringify({ delegation: { enabled: true }, warmStart: false }));
    expect(fixture.get().agents?.warmStart).toBe(false);
    expect(fixture.get().agents?.delegation?.enabled).toBe(true);
  });
});

describe('agent health check in the browser fixture', () => {
  it('is on by default and only the user scope can turn it off', () => {
    const fixture = createPreviewSettings();
    expect(fixture.get().agents?.healthCheck).toBe(true);
    fixture.update('workspace', 'agents', JSON.stringify({ healthCheck: false }));
    expect(fixture.get().agents?.healthCheck).toBe(true);
    fixture.update('user', 'agents', JSON.stringify({ healthCheck: false }));
    expect(fixture.get().agents?.healthCheck).toBe(false);
  });
});
