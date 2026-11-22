// Menjalankan migrasi SQL di db/migrations. Pemakaian: node scripts/migrate.js up|down
// MIGRATE_SCHEMA (opsional): jalankan di skema terpisah (dipakai tes agar terisolasi).
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
const skema = process.env.MIGRATE_SCHEMA;
if (skema && !/^[a-z_][a-z0-9_]{0,40}$/.test(skema)) {
  console.error('MIGRATE_SCHEMA tidak valid');
  process.exit(1);
}
runner({
  databaseUrl: url,
  dir: process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', '..', 'db', 'migrations'), // MIGRATIONS_DIR: dipakai image produksi (tata letak berbeda)
  direction: arah,
  count: arah === 'down' ? 1 : Infinity,
  migrationsTable: 'schema_migrations',
  ...(skema ? { schema: skema, migrationsSchema: skema, createSchema: true } : {}),
  log: () => {},
})
  .then((m) => console.log(`Migrasi ${arah}: ${m.length} berkas`))
  .catch((e) => {
    console.error('Migrasi gagal:', e.message);
    process.exit(1);
  });
