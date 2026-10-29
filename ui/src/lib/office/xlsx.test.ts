// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  colToIndex, evaluateCellIs, formatCellValue, formatRef, indexToCol, isDateFormat, isPercentFormat, mergeLayout, parseRange, parseRef, parseSharedStrings,
  parseXlsx, translateFormula,
} from './xlsx';
import { buildXlsx } from './test-fixtures';

describe('cell reference math', () => {
  it('converts column letters and indexes both ways', () => {
    expect([colToIndex('A'), colToIndex('Z'), colToIndex('AA'), colToIndex('AZ'), colToIndex('BA'), colToIndex('XFD')]).toEqual([0, 25, 26, 51, 52, 16383]);
    for (const n of [0, 25, 26, 51, 52, 701, 702, 16383]) expect(colToIndex(indexToCol(n))).toBe(n);
    expect(indexToCol(702)).toBe('AAA');
  });
  it('parses absolute and relative references and ranges', () => {
    expect(parseRef('B12')).toEqual({ row: 11, col: 1 });
    expect(parseRef('$C$3')).toEqual({ row: 2, col: 2 });
    expect(parseRef('3C')).toBeUndefined();
    expect(formatRef(0, 27)).toBe('AB1');
    expect(parseRange('A1:C3')).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
    expect(parseRange('D4')).toEqual({ start: { row: 3, col: 3 }, end: { row: 3, col: 3 } });
  });
});

describe('number formats', () => {
  it('detects date formats and ignores quoted text, colours and locales', () => {
    for (const code of ['yyyy-mm-dd', 'd/m/yy', 'mmm d, yyyy', 'h:mm AM/PM', '[h]:mm:ss', '[$-409]mmmm d', 'dd"th"']) expect(isDateFormat(code)).toBe(true);
    for (const code of ['General', '0.00', '#,##0', '0%', '"days"0', '[Red]0.00', '0.00E+00', '@']) expect(isDateFormat(code)).toBe(false);
  });
  it('detects percent formats', () => {
    expect(isPercentFormat('0%')).toBe(true);
    expect(isPercentFormat('0.00%')).toBe(true);
    expect(isPercentFormat('"%"0')).toBe(false);
  });
  it('formats dates, percents and plain numbers', () => {
    expect(formatCellValue(46323, 'yyyy-mm-dd')).toBe('2026-10-28');
    expect(formatCellValue(46323.5, 'yyyy-mm-dd h:mm')).toBe('2026-10-28 12:00');
    expect(formatCellValue(0.75, 'h:mm')).toBe('18:00');
    expect(formatCellValue(1, 'yyyy-mm-dd', true)).toBe('1904-01-02');
    expect(formatCellValue(0.1234, '0.0%')).toBe('12.3%');
    expect(formatCellValue(0.5, '0%')).toBe('50%');
    expect(formatCellValue(0.1 + 0.2, 'General')).toBe('0.3');
    expect(formatCellValue(1234.5, '#,##0.00')).toBe('1234.5');
  });
});

describe('shared strings', () => {
  it('reads plain and rich text items and skips phonetic runs', () => {
    const xml = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Plain</t></si><si><r><t>Rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh><t>ignored</t></rPh></si><si><t xml:space="preserve"> padded </t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(['Plain', 'Rich text', ' padded ']);
  });
});

describe('formulas', () => {
  it('shifts relative references of a shared formula and keeps absolute ones', () => {
    expect(translateFormula('MEDIAN(B2:D2)', 2, 0)).toBe('MEDIAN(B4:D4)');
    expect(translateFormula('$A$1+A1+$A1+A$1', 1, 1)).toBe('$A$1+B2+$A2+B$1');
    expect(translateFormula('"A1"&LOG10(B1)', 1, 0)).toBe('"A1"&LOG10(B2)');
    expect(translateFormula('Sheet2!C3*2', 0, 1)).toBe('Sheet2!D3*2');
  });
});

describe('merged cells', () => {
  it('spans the anchor and skips covered cells inside the window', () => {
    const layout = mergeLayout([parseRange('B2:C3')!], 0, 10);
    expect(layout.get('1,1')).toEqual({ rowSpan: 2, colSpan: 2 });
    expect(layout.get('1,2')).toBe('skip');
    expect(layout.get('2,1')).toBe('skip');
    expect(layout.get('2,2')).toBe('skip');
    expect(layout.get('0,0')).toBeUndefined();
  });
  it('clips a merge at the window edges and re-anchors at the window start', () => {
    const layout = mergeLayout([parseRange('A1:A5')!], 2, 4);
    expect(layout.get('2,0')).toEqual({ rowSpan: 2, colSpan: 1 });
    expect(layout.get('3,0')).toBe('skip');
  });
});

describe('conditional formatting', () => {
  it('evaluates simple cellIs operators against constants', () => {
    expect(evaluateCellIs({ operator: 'greaterThan', formulas: ['100'] }, 120)).toBe(true);
    expect(evaluateCellIs({ operator: 'lessThan', formulas: ['100'] }, 120)).toBe(false);
    expect(evaluateCellIs({ operator: 'between', formulas: ['1', '5'] }, 5)).toBe(true);
    expect(evaluateCellIs({ operator: 'notBetween', formulas: ['1', '5'] }, 6)).toBe(true);
    expect(evaluateCellIs({ operator: 'equal', formulas: ['"Done"'] }, 'Done')).toBe(true);
    expect(evaluateCellIs({ operator: 'greaterThan', formulas: ['$F2'] }, 120)).toBe(false);
  });
});

describe('workbook parsing', () => {
  const book = () => buildXlsx([
    {
      name: 'Startup', dimension: 'A1:E3', merges: ['A3:B3'],
      rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>0.125</v></c><c r="C2" s="2"><v>46323</v></c><c r="D2"><f>SUM(1,2)</f><v>3</v></c><c r="E2" t="b"><v>1</v></c></row>'
        + '<row r="3"><c r="A3" t="inlineStr"><is><t>Merged</t></is></c><c r="D3"><f t="shared" ref="D3:D4" si="0">D2*2</f><v>6</v></c><c r="E3" t="e"><v>#DIV/0!</v></c></row>'
        + '<row r="4"><c r="D4"><f t="shared" si="0"/><v>12</v></c></row>',
      cf: '<conditionalFormatting sqref="D2:D4"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>',
    },
    { name: 'Hidden', rows: '', hidden: true },
    { name: 'Raw', rows: '<row r="1"><c r="A1"><v>1</v></c></row>' },
  ], ['Name', 'Share', 'Date', 'Cold start'], [[164, 'yyyy-mm-dd']], [0, 10, 164], '<dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>');

  it('reads sheets, shared strings, styles, formulas with cached values, merges and errors', () => {
    const wb = parseXlsx(book());
    expect(wb.sheets.map(s => s.name)).toEqual(['Startup', 'Raw']);
    expect(wb.hiddenSheets).toBe(1);
    const s = wb.sheets[0];
    expect(s.totalRows).toBe(4);
    const cell = (ref: string) => { const { row, col } = parseRef(ref)!; return s.cells.get(row)?.get(col); };
    expect(cell('A1')?.display).toBe('Name');
    expect(cell('B2')?.display).toBe('12.50%');
    expect(cell('C2')?.display).toBe('2026-10-28');
    expect(cell('D2')).toMatchObject({ formula: '=SUM(1,2)', display: '3', value: 3 });
    expect(cell('D4')).toMatchObject({ formula: '=D3*2', display: '12' });
    expect(cell('E2')?.display).toBe('TRUE');
    expect(cell('E3')).toMatchObject({ display: '#DIV/0!', type: 'e' });
    expect(cell('A3')?.display).toBe('Merged');
    expect(s.merges).toEqual([parseRange('A3:B3')]);
  });
  it('applies conditional formatting only where the file defines it', () => {
    const s = parseXlsx(book()).sheets[0];
    expect(s.cfStyle(1, 3)).toBeUndefined();
    expect(s.cfStyle(2, 3)).toEqual({ color: '#9C0006', background: '#FFC7CE' });
    expect(parseXlsx(book()).sheets[1].cfStyle(0, 0)).toBeUndefined();
  });
  it('caps rows and columns and says how many exist', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="Z${i + 1}"><v>1</v></c></row>`).join('');
    const s = parseXlsx(buildXlsx([{ name: 'Big', rows }]), { maxRows: 10, maxCols: 5 }).sheets[0];
    expect(s.totalRows).toBe(30);
    expect(s.rowCount).toBe(10);
    expect(s.colCount).toBe(5);
    expect(s.colsCapped).toBe(true);
    expect(s.rowsCapped).toBe(true);
  });
});
