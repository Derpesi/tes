/** Token injeksi pool PostgreSQL. Dipisah dari modul agar tidak terjadi impor melingkar. */
export const POOL = Symbol('PG_POOL');
