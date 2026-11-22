import type { ReactNode } from 'react';

export function Halaman({ judul, children }: { judul: string; children: ReactNode }) {
  return (
    <div className="halaman">
      <header className="kepala">
        <h1>DAMARINDO GROUP HRIS</h1>
      </header>
      <main className="isi">
        <h2>{judul}</h2>
        {children}
      </main>
    </div>
  );
}

export function Galat({ pesan }: { pesan: string | null }) {
  return pesan ? (
    <div className="galat" role="alert">
      {pesan}
    </div>
  ) : null;
}

export function Sukses({ pesan }: { pesan: string | null }) {
  return pesan ? (
    <div className="sukses" role="status">
      {pesan}
    </div>
  ) : null;
}

export function Kolom(p: { id: string; label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete?: string; inputMode?: 'numeric' | 'decimal' | 'text' | 'email'; bantuan?: string; required?: boolean; maxLength?: number }) {
  return (
    <div className="kolom">
      <label htmlFor={p.id}>{p.label}</label>
      <input id={p.id} name={p.id} type={p.type ?? 'text'} value={p.value} onChange={(e) => p.onChange(e.target.value)} autoComplete={p.autoComplete} inputMode={p.inputMode} required={p.required ?? true} maxLength={p.maxLength} aria-describedby={p.bantuan ? `${p.id}-bantuan` : undefined} />
      {p.bantuan ? (
        <span id={`${p.id}-bantuan`} className="bantuan">
          {p.bantuan}
        </span>
      ) : null}
    </div>
  );
}

export function Pilihan(p: { id: string; label: string; value: string; onChange: (v: string) => void; opsi: { nilai: string; teks: string }[]; required?: boolean }) {
  return (
    <div className="kolom">
      <label htmlFor={p.id}>{p.label}</label>
      <select id={p.id} name={p.id} value={p.value} onChange={(e) => p.onChange(e.target.value)} required={p.required ?? true}>
        <option value="">Pilih…</option>
        {p.opsi.map((o) => (
          <option key={o.nilai} value={o.nilai}>
            {o.teks}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Lencana({ status }: { status: string }) {
  return <span className={`lencana lencana-${status.toLowerCase()}`}>{status.replace(/_/g, ' ')}</span>;
}

export function AreaTeks(p: { id: string; label: string; value: string; onChange: (v: string) => void; maxLength?: number; bantuan?: string; baris?: number; required?: boolean }) {
  return (
    <div className="kolom">
      <label htmlFor={p.id}>{p.label}</label>
      <textarea id={p.id} name={p.id} value={p.value} onChange={(e) => p.onChange(e.target.value)} maxLength={p.maxLength} rows={p.baris ?? 6} required={p.required ?? true} aria-describedby={p.bantuan ? `${p.id}-bantuan` : undefined} />
      {p.bantuan ? (
        <span id={`${p.id}-bantuan`} className="bantuan">
          {p.bantuan}
        </span>
      ) : null}
    </div>
  );
}
