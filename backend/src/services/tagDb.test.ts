import { describe, expect, it } from 'bun:test';

import {
  parseAliasExport,
  parseCsvRows,
  parseImplicationExport,
  rowsToRecords
} from './tagDb';

describe('parseCsvRows', () => {
  it('reads plain rows', () => {
    expect(parseCsvRows('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });

  it('keeps commas that sit inside a quoted field', () => {
    // The exports quote `reason`, which routinely carries a comma.
    expect(parseCsvRows('id,reason\n7,"one, two"\n')).toEqual([
      ['id', 'reason'],
      ['7', 'one, two']
    ]);
  });

  it('keeps a newline inside a quoted field on the same row', () => {
    expect(parseCsvRows('id,reason\n7,"one\ntwo"\n')).toEqual([
      ['id', 'reason'],
      ['7', 'one\ntwo']
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsvRows('id,reason\n7,"say ""hi"""\n')[1]).toEqual([
      '7',
      'say "hi"'
    ]);
  });

  it('reads CRLF without emitting blank rows', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });

  it('keeps a last row that has no trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2')).toHaveLength(2);
  });
});

describe('rowsToRecords', () => {
  it('keys the body by the header', () => {
    expect(
      rowsToRecords([
        ['a', 'b'],
        ['1', '2']
      ])
    ).toEqual([{ a: '1', b: '2' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(rowsToRecords([])).toEqual([]);
  });
});

const aliasCsv = [
  'id,antecedent_name,consequent_name,created_at,status',
  '1,1girls,female,,active',
  '2,2d,invalid_tag,,active',
  '3,susie,susie_(disambiguation),,active',
  '4,oldname,newname,,deleted',
  '5,same,same,,active',
  '6,straight,male/female,,active'
].join('\n');

describe('parseAliasExport', () => {
  it('keeps an active alias', () => {
    expect(parseAliasExport(aliasCsv)).toContainEqual({
      antecedent: '1girls',
      consequent: 'female'
    });
  });

  it('drops the buckets e621 parks unwanted tags in', () => {
    const antecedents = parseAliasExport(aliasCsv).map((a) => a.antecedent);
    expect(antecedents).not.toContain('2d');
    expect(antecedents).not.toContain('susie');
  });

  it('drops rows that are not active', () => {
    expect(parseAliasExport(aliasCsv).map((a) => a.antecedent)).not.toContain(
      'oldname'
    );
  });

  it('normalises tags the way stored tags are normalised', () => {
    // `male/female` is stored and searched as `malefemale`; keeping the raw
    // form would point the alias at a tag nothing can ever match.
    expect(parseAliasExport(aliasCsv)).toContainEqual({
      antecedent: 'straight',
      consequent: 'malefemale'
    });
  });

  it('drops a row whose antecedent normalisation makes it ambiguous', () => {
    // `female/?` normalises to `female`, so honouring it would redirect
    // every `female` tag in the library to `female/ambiguous`.
    const csv = [
      'id,antecedent_name,consequent_name,created_at,status',
      '1,female/?,female/ambiguous,,active',
      '2,?/female,female/ambiguous,,active'
    ].join('\n');
    expect(parseAliasExport(csv)).toEqual([]);
  });

  it('drops an alias that only normalisation makes self-referential', () => {
    const csv = [
      'id,antecedent_name,consequent_name,created_at,status',
      '1,malefemale,male/female,,active'
    ].join('\n');
    expect(parseAliasExport(csv)).toEqual([]);
  });

  it('drops an alias that points at itself', () => {
    expect(parseAliasExport(aliasCsv).map((a) => a.antecedent)).not.toContain(
      'same'
    );
  });
});

describe('parseImplicationExport', () => {
  const csv = [
    'id,antecedent_name,consequent_name,created_at,status',
    '1,husky,dog,,active',
    '2,husky,pet,,active',
    '3,dog,canine,,active',
    '4,gone,nowhere,,deleted'
  ].join('\n');

  it('groups every parent of a tag', () => {
    const direct = parseImplicationExport(csv);
    expect([...direct.get('husky')!].sort()).toEqual(['dog', 'pet']);
  });

  it('drops rows that are not active', () => {
    expect(parseImplicationExport(csv).has('gone')).toBe(false);
  });

  it('drops a row whose antecedent normalisation makes it ambiguous', () => {
    const ambiguous = [
      'id,antecedent_name,consequent_name,created_at,status',
      '1,female/?,ambiguous_gender,,active'
    ].join('\n');
    expect(parseImplicationExport(ambiguous).size).toBe(0);
  });
});
