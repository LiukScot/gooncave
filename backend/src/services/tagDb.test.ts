import { afterEach, describe, expect, it } from 'bun:test';

import { disarmFetchMock, setupFetchMock } from '../../test/helpers/fetchMock';

import {
  aliasPairs,
  danbooruAliasesToKeep,
  downloadDanbooru,
  fetchDanbooruCategories,
  nameBatches,
  parseAliasExport,
  parseImplicationExport,
  parseTagCategoryExport,
  readCsvRecords,
  readCsvRows
} from './tagDb';

const parseCsvRows = (text: string) => [...readCsvRows(text)];

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

describe('readCsvRecords', () => {
  it('keys the body by the header', () => {
    expect([...readCsvRecords('a,b\n1,2\n')]).toEqual([{ a: '1', b: '2' }]);
  });

  it('returns nothing for an empty file', () => {
    expect([...readCsvRecords('')]).toEqual([]);
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

describe('aliasPairs', () => {
  it('normalises API rows the same way the export is normalised', () => {
    // The Danbooru API answers with the field names the export uses, so the
    // two sources share one normalisation pass.
    expect(
      aliasPairs([
        { antecedent_name: '1girls', consequent_name: 'female' },
        { antecedent_name: '2d', consequent_name: 'invalid_tag' }
      ])
    ).toEqual([{ antecedent: '1girls', consequent: 'female' }]);
  });
});

describe('danbooruAliasesToKeep', () => {
  const e621 = [{ antecedent: 'ass', consequent: 'butt' }];

  it('keeps a row about tags e621 says nothing about', () => {
    expect(
      danbooruAliasesToKeep(e621, [
        { antecedent: 'a_yin', consequent: 'ke_shi_yinhe' }
      ])
    ).toEqual([{ antecedent: 'a_yin', consequent: 'ke_shi_yinhe' }]);
  });

  it('drops a row that would send an e621 consequent back down', () => {
    // e621: ass -> butt, danbooru: butt -> ass. Merged, neither resolves to
    // the other any more and searching one stops finding the other.
    expect(
      danbooruAliasesToKeep(e621, [{ antecedent: 'butt', consequent: 'ass' }])
    ).toEqual([]);
  });

  it('drops a row that disagrees with e621 about the same antecedent', () => {
    expect(
      danbooruAliasesToKeep(e621, [{ antecedent: 'ass', consequent: 'booty' }])
    ).toEqual([]);
  });
});

describe('parseTagCategoryExport', () => {
  const csv = [
    'id,name,category,post_count',
    '1,bat,5,4210',
    '2,solo,0,900000',
    '3,deadname,4,0',
    '4,absurd_res,7,120',
    '5,female/?,5,30',
    '6,thighs,6,880'
  ].join('\n');

  it('maps e621 category numbers onto the stored names', () => {
    expect([...parseTagCategoryExport(csv)]).toContainEqual({
      tag: 'bat',
      category: 'species'
    });
    expect([...parseTagCategoryExport(csv)]).toContainEqual({
      tag: 'absurd_res',
      category: 'meta'
    });
  });

  it("keeps e621's general verdicts, which mark a tag as placed", () => {
    // Not for the category itself — the write path already defaults to
    // general — but to tell "e621 says this is general" apart from "e621
    // has never heard of it". Only the second is worth asking danbooru.
    expect([...parseTagCategoryExport(csv)]).toContainEqual({
      tag: 'solo',
      category: 'general'
    });
  });

  it('drops tags no post carries', () => {
    expect(
      [...parseTagCategoryExport(csv)].map((row) => row.tag)
    ).not.toContain('deadname');
  });

  it("drops e621's invalid bin, which holds ordinary local tags", () => {
    // `thighs`, `mouth`, `brown` live there. They come straight out of the
    // tagger, and filing them under a category that reads as broken is
    // worse than leaving them general.
    expect(
      [...parseTagCategoryExport(csv)].map((row) => row.tag)
    ).not.toContain('thighs');
  });

  it('drops a name that normalisation makes ambiguous', () => {
    // `female/?` normalises to `female`, which would categorise the
    // library's most common tag from a row that is not about it.
    expect(
      [...parseTagCategoryExport(csv)].map((row) => row.tag)
    ).not.toContain('female');
  });
});

describe('downloadDanbooru', () => {
  afterEach(disarmFetchMock);

  // The real waits are seconds long; the retry logic is the same at 1ms.
  const fastDelays = [1, 1, 1];
  const isAliases = (url: string) => url.includes('/tag_aliases.json');
  const page = (rows: { id: number; name: string }[]) =>
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        antecedent_name: row.name,
        consequent_name: 'canonical'
      }))
    );

  it('retries a rate limit instead of failing the whole import', async () => {
    // ~90 pages back to back earns a 429 often enough that it happened
    // three times during development; before the retry it threw the import
    // away, e621 half included.
    const mock = setupFetchMock();
    mock.intercept(isAliases, { status: 429 });
    mock.intercept(isAliases, {
      status: 200,
      body: page([{ id: 7, name: 'a' }])
    });

    expect(await downloadDanbooru('tag_aliases', fastDelays)).toEqual([
      { id: 7, antecedent_name: 'a', consequent_name: 'canonical' }
    ]);
  });

  it('retries a dead socket, which no status code can express', async () => {
    const mock = setupFetchMock();
    mock.intercept(isAliases, { status: 0, throws: 'ECONNRESET' });
    mock.intercept(isAliases, {
      status: 200,
      body: page([{ id: 7, name: 'a' }])
    });

    expect(await downloadDanbooru('tag_aliases', fastDelays)).toHaveLength(1);
  });

  it('gives up once the retries are spent', async () => {
    const mock = setupFetchMock();
    mock.intercept(isAliases, { status: 429, persist: true });

    await expect(downloadDanbooru('tag_aliases', fastDelays)).rejects.toThrow(
      'kept failing after 4 tries (HTTP 429)'
    );
  });

  it('gives up at once on a status that will not change on its own', async () => {
    const mock = setupFetchMock();
    mock.intercept(isAliases, { status: 404, persist: true });

    await expect(downloadDanbooru('tag_aliases')).rejects.toThrow('HTTP 404');
  });
});

describe('fetchDanbooruCategories', () => {
  afterEach(disarmFetchMock);

  const isTags = (url: string) => url.includes('/tags.json');
  const rows = (entries: [name: string, category: number, posts: number][]) =>
    JSON.stringify(
      entries.map(([name, category, post_count]) => ({
        name,
        category,
        post_count
      }))
    );

  it('keeps only the verdicts worth storing', async () => {
    const mock = setupFetchMock();
    mock.intercept(isTags, {
      status: 200,
      body: rows([
        ['fi_zz_ill', 1, 258],
        ['hololive_english', 3, 87901],
        ['looking_at_viewer', 0, 900000],
        ['deprecated_spelling', 4, 0]
      ])
    });

    expect(await fetchDanbooruCategories(['a'])).toEqual([
      { tag: 'fi_zz_ill', category: 'artist' },
      { tag: 'hololive_english', category: 'copyright' }
    ]);
  });

  it('asks in one request when the names fit', async () => {
    const mock = setupFetchMock();
    const seen: string[] = [];
    mock.intercept(
      (url) => {
        if (!isTags(url)) return false;
        seen.push(new URL(url).searchParams.get('search[name_comma]') ?? '');
        return true;
      },
      { status: 200, body: rows([]), persist: true }
    );

    await fetchDanbooruCategories(
      Array.from({ length: 150 }, (_, index) => `tag${index}`)
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].split(',')).toHaveLength(150);
  });
});

describe('nameBatches', () => {
  it('splits on encoded length, not on a count of names', () => {
    // Tag names have no length cap. Batching by count would put 100 long
    // ones in one query string, and the 414 that comes back is not
    // retryable — it would throw the whole import away.
    const long = 'a'.repeat(170);
    const batches = [...nameBatches(Array.from({ length: 100 }, () => long))];

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(encodeURIComponent(batch.join(',')).length).toBeLessThan(4_500);
    }
    expect(batches.flat()).toHaveLength(100);
  });

  it('keeps a single oversized name rather than dropping it', () => {
    const huge = 'b'.repeat(9_000);
    expect([...nameBatches([huge, 'x'])]).toEqual([[huge], ['x']]);
  });
});
