"use client";
import { useEffect, useState } from 'react';

type UpdateMode = 'update' | 'version';

function getCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()!.split(';').shift() || null;
  return null;
}

function setCookie(name: string, value: string, days = 365) {
  if (typeof document === 'undefined') return;
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

export function UpdateModeToggle() {
  const [mode, setMode] = useState<UpdateMode>('update');

  useEffect(() => {
    const cookie = getCookie('artifact_update_mode');
    if (cookie === 'version' || cookie === 'update') {
      setMode(cookie);
    }
  }, []);

  useEffect(() => {
    setCookie('artifact_update_mode', mode);
  }, [mode]);

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Update Strategy</span>
      <div className="inline-flex rounded-md border overflow-hidden">
        <button
          type="button"
          className={
            'px-2 py-1 text-xs ' +
            (mode === 'update'
              ? 'bg-primary text-primary-foreground'
              : 'bg-background hover:bg-muted')
          }
          onClick={() => setMode('update')}
          aria-pressed={mode === 'update'}
        >
          Overwrite
        </button>
        <button
          type="button"
          className={
            'px-2 py-1 text-xs border-l ' +
            (mode === 'version'
              ? 'bg-primary text-primary-foreground'
              : 'bg-background hover:bg-muted')
          }
          onClick={() => setMode('version')}
          aria-pressed={mode === 'version'}
        >
          New Version
        </button>
      </div>
    </div>
  );
}

