// Menjalankan migrasi SQL di db/migrations. Pemakaian: node scripts/migrate.js up|down
const path = require('node:path');
const { runner } = require('node-pg-migrate');

const arah = process.argv[2];
if (!['up', 'down'].includes(arah)) {
  console.error('Pemakaian: node scripts/migrate.js up|down');
  process.exit(1);
}
const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL belum diatur');
  process.exit(1);
}
runner({
  databaseUrl: url,
  dir: path.join(__dirname, '..', '..', '..', 'db', 'migrations'),
  direction: arah,
  count: arah === 'down' ? 1 : Infinity,
  migrationsTable: 'schema_migrations',
  log: () => {},
})
  .then((m) => console.log(`Migrasi ${arah}: ${m.length} berkas`))
  .catch((e) => {
    console.error('Migrasi gagal:', e.message);
    process.exit(1);
  });
