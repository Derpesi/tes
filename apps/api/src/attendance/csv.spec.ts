import { dokumenCsv, selCsv } from './csv';

describe('csv aman', () => {
  it.each(['=1+1', '+cmd|"x"', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'])('sel berbahaya %j diawali apostrof', (v) => {
    expect(selCsv(v).replace(/^"/, '').startsWith("'")).toBe(true);
  });
  it('sel normal tetap, angka dan null aman', () => {
    expect(selCsv('Budi')).toBe('Budi');
    expect(selCsv(12)).toBe('12');
    expect(selCsv(null)).toBe('');
    expect(selCsv(undefined)).toBe('');
  });
  it('sel dengan koma, kutip, titik koma, atau baris baru dikutip dan kutip digandakan', () => {
    expect(selCsv('a,b')).toBe('"a,b"');
    expect(selCsv('dia "bilang"')).toBe('"dia ""bilang"""');
    expect(selCsv('a;b')).toBe('"a;b"');
    expect(selCsv('baris1\nbaris2')).toBe('"baris1\nbaris2"');
    expect(selCsv('=HYPERLINK("http://x","klik")')).toBe(`"'=HYPERLINK(""http://x"",""klik"")"`);
  });
  it('dokumen: BOM, kepala, CRLF', () => {
    expect(dokumenCsv(['A', 'B'], [['1', '=2']])).toBe(String.fromCharCode(0xfeff) + "A,B\r\n1,'=2\r\n");
  });
});
