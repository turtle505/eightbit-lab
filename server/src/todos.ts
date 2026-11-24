import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tr } from '../../shared/i18n.ts';
import type { TodayTodos, TodoOp } from '../../shared/protocol.ts';
import type { ObsidianConfig } from './config.ts';
import { applyTodoOp, dailyPath, localDate, parseDaily } from './obsidian.ts';

const OFF: TodayTodos = { enabled: false, date: '', relPath: '', exists: false, mtime: 0, vaultName: '', canCreate: false, sections: [], error: '' };

/** Today's Obsidian daily note: the file is the source of truth; the app reads it and edits single lines. */
export class TodayNote {
  private last = '';

  constructor(
    private cfg: ObsidianConfig | null,
    private now: () => Date = () => new Date(),
  ) {}

  private file(): { rel: string; abs: string } {
    const rel = dailyPath(this.cfg!.daily, this.now());
    const abs = resolve(this.cfg!.vault, rel);
    if (!abs.startsWith(resolve(this.cfg!.vault) + sep)) throw new Error(tr({ ko: 'daily 경로가 vault 밖을 가리킵니다.', en: 'The daily path points outside the vault.' }));
    return { rel, abs };
  }

  load(): TodayTodos {
    if (!this.cfg) return OFF;
    const base: TodayTodos = {
      ...OFF,
      enabled: true,
      date: localDate(this.now()),
      vaultName: basename(this.cfg.vault),
      canCreate: this.cfg.createCommand.length > 0,
    };
    try {
      const { rel, abs } = this.file();
      base.relPath = rel;
      if (!existsSync(abs)) return base;
      const text = readFileSync(abs, 'utf8');
      return { ...base, exists: true, mtime: Math.round(statSync(abs).mtimeMs), sections: parseDaily(text) };
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }

  /** Reload; returns the data only when something changed since the last call (mtime, date, existence). */
  poll(): TodayTodos | null {
    const t = this.load();
    const key = `${t.date}|${t.exists}|${t.mtime}|${t.error}`;
    if (key === this.last) return null;
    this.last = key;
    return t;
  }

  /** Edit one line. Each op carries the line's original text, so edits made meanwhile (Obsidian, an agent) are refused, not clobbered. */
  apply(op: TodoOp): TodayTodos {
    if (!this.cfg) throw new Error(
        tr({
          ko: 'Obsidian vault가 설정되지 않았습니다 (office.local.yaml 의 obsidian.vault).',
          en: 'No Obsidian vault configured (obsidian.vault in office.local.yaml).',
        }),
      );
    const { abs } = this.file();
    if (!existsSync(abs)) throw new Error(tr({ ko: '오늘 노트가 없습니다.', en: "There is no note for today." }));
    const next = applyTodoOp(readFileSync(abs, 'utf8'), op);
    const tmp = join(dirname(abs), `.${basename(abs)}.office-tmp`);
    writeFileSync(tmp, next);
    renameSync(tmp, abs);
    this.last = '';
    return this.poll() ?? this.load();
  }

  /** Run the configured note-creation command (argv, no shell, cwd = vault). */
  create(): Promise<string> {
    const cfg = this.cfg;
    if (!cfg || !cfg.createCommand.length) return Promise.reject(new Error(tr({ ko: '노트 생성 명령(obsidian.createCommand)이 설정되지 않았습니다.', en: 'No note creation command configured (obsidian.createCommand).' })));
    const [cmd, ...args] = cfg.createCommand.map((a) => a.replace(/\{vault\}/g, cfg.vault));
    return new Promise((res, rej) =>
      execFile(cmd, args, { cwd: cfg.vault, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) rej(new Error(tr({ ko: `노트 생성 실패: ${(stderr || err.message).trim().slice(0, 300)}`, en: `Failed to create the note: ${(stderr || err.message).trim().slice(0, 300)}` })));
        else res(stdout.trim());
      }),
    );
  }
}
