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

export function Kolom(p: { id: string; label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete?: string; inputMode?: 'numeric' | 'text' | 'email'; bantuan?: string; required?: boolean; maxLength?: number }) {
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
