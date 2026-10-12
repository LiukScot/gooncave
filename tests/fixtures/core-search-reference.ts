import { writeFileSync } from 'node:fs';

// Run with: bun tests/fixtures/core-search-reference.ts
process.env.DATA_FILE = ':memory:';
const { sqlite } = await import('../../backend/src/db/client');
const { runMigrations } = await import('../../backend/src/db/migrate');
const { parseTagQuery } = await import('../../backend/src/lib/tagQuery');
const { buildFileTagFilter } = await import('../../backend/src/db/repos/files/shared');
const { resolveAlias } = await import('../../backend/src/lib/tagAliases');
runMigrations();
sqlite.exec(`INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES ('owner','owner','disabled','now','now');
  INSERT INTO folders (id,user_id,path,type,created_at,updated_at,status) VALUES ('root','owner','/example','LOCAL','now','now','IDLE');`);
for (const id of ['a','b','c']) {
  sqlite.prepare(`INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at)
    VALUES (?,'root','LOCAL',?,1,'now',?,'IMAGE','now','now')`).run(id,id,id);
}
const aliases = new Map([['puppy', 'dog']]);
for (const [id,tags] of [['a',['puppy','blue_eyes']],['b',['dog','hidden']],['c',['cat']]] as const) {
  for (const tag of tags) sqlite.prepare(`INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,created_at,updated_at)
    VALUES (?,?,?,'species','MANUAL','now','now')`).run(id,tag,resolveAlias(tag,aliases));
}
sqlite.exec("INSERT INTO tag_implications VALUES ('dog','animal')");
const queries = ['puppy -hidden -cat','animal','~dog ~cat','dog blue_eyes','-dog','score:0',
  'score:>0','-score:>0','~score:0 ~cat','-Blue_Eyes','dog,blue_eyes','parent:any','pool:any',
  'score: score:abc','~cat ~dog -hidden','puppy puppy','~puppy ~dog', 'dog -animal'];
const cases = queries.map((input) => {
  const query = parseTagQuery(input);
  for (const bucket of [query.all,query.any,query.none]) {
    bucket.splice(0,bucket.length,...new Set(bucket.map((tag) => resolveAlias(tag,aliases))));
  }
  const filter = buildFileTagFilter(query);
  const where = filter.where.length ? `WHERE ${filter.where.join(' AND ')}` : '';
  const ids = sqlite.prepare(`SELECT f.id FROM files f ${filter.join} ${where} ORDER BY f.id`)
    .all(...filter.joinParams,...filter.whereParams).map((row) => {
      if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') throw new Error('Invalid reference result');
      return row.id;
    });
  return {query:input,ids};
});
writeFileSync(new URL('./core-search-reference.json',import.meta.url),JSON.stringify(cases,null,2)+'\n');
sqlite.close();
