import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { tr } from '../../shared/i18n.ts';
import type { SkillView } from '../../shared/protocol.ts';
import type { Store } from './db.ts';

export const PLUGIN_NAME = 'office';
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

interface Parsed {
  name: string;
  description: string;
  allow: string[];
  body: string;
  hash: string;
}

/**
 * Office skills live in a local Claude Code plugin (workspaces/office-skills, git-ignored) that every
 * employee session loads, so they are invoked as `office:<name>`.
 *
 * A skill's frontmatter may list `office-allow` tool rules that a routine running the skill gets
 * auto-allowed. That only holds while the file is byte-identical to what the manager approved
 * (sha256 pinned in the DB): employees can Write files, so an edited skill loses its extra permissions.
 */
export class SkillLibrary {
  constructor(
    readonly dir: string,
    private store: Store,
  ) {}

  ensure() {
    const manifest = resolve(this.dir, '.claude-plugin/plugin.json');
    if (!existsSync(manifest)) {
      mkdirSync(resolve(this.dir, '.claude-plugin'), { recursive: true });
      writeFileSync(manifest, JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: '8-bit Lab office skills (for routines)' }, null, 2) + '\n');
    }
    mkdirSync(resolve(this.dir, 'skills'), { recursive: true });
  }

  private file(name: string) {
    return resolve(this.dir, 'skills', name, 'SKILL.md');
  }

  private read(name: string): Parsed | null {
    const p = this.file(name);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    let fm: Record<string, any> = {};
    let bad = !m;
    try {
      fm = (m && parse(m[1])) || {};
    } catch {
      bad = true;
    }
    const allow = Array.isArray(fm['office-allow']) ? fm['office-allow'].map(String) : [];
    return {
      name,
      description: bad
        ? tr({ ko: '⚠️ SKILL.md 프런트매터(YAML)를 읽을 수 없습니다', en: '⚠️ Cannot read the SKILL.md front matter (YAML)' })
        : String(fm.description ?? ''),
      allow,
      body: m ? m[2] : raw,
      hash: createHash('sha256').update(raw).digest('hex'),
    };
  }

  has(name: string): boolean {
    return NAME_RE.test(name) && existsSync(this.file(name));
  }

  list(): SkillView[] {
    const root = resolve(this.dir, 'skills');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
      .map((d) => this.view(d.name))
      .filter((v): v is SkillView => v !== null);
  }

  view(name: string): SkillView | null {
    const s = this.read(name);
    if (!s) return null;
    const ap = this.store.getSkillApproval(name);
    return { name, description: s.description, allow: s.allow, approved: !!ap && ap.hash === s.hash };
  }

  /** Write (or overwrite) a skill and approve it as written. Callers must have the manager's approval. */
  save(name: string, description: string, body: string, allow: string[]): SkillView {
    if (!NAME_RE.test(name)) throw new Error(`Skill names may use only lowercase letters, digits and hyphens (2-41 chars): "${name}"`);
    if (!description.trim()) throw new Error('The skill description is empty.');
    if (!body.trim()) throw new Error('The skill body is empty.');
    const fm: Record<string, unknown> = { name, description: description.trim() };
    const rules = allow.map((a) => a.trim()).filter(Boolean);
    if (rules.length) fm['office-allow'] = rules;
    mkdirSync(resolve(this.dir, 'skills', name), { recursive: true });
    writeFileSync(this.file(name), `---\n${stringify(fm).trimEnd()}\n---\n\n${body.trim()}\n`);
    return this.approve(name);
  }

  /** Approve the skill file as it is now (e.g. after the manager edited it by hand). */
  approve(name: string): SkillView {
    const s = this.read(name);
    if (!s) throw new Error(tr({ ko: `스킬 ${name}을(를) 찾을 수 없습니다.`, en: `Skill ${name} not found.` }));
    this.store.setSkillApproval(name, s.allow, s.hash);
    return this.view(name)!;
  }

  /** Extra tool rules for an unattended run, or null if the skill changed since approval (or is missing). */
  allowFor(name: string): string[] | null {
    const s = this.read(name);
    const ap = this.store.getSkillApproval(name);
    if (!s || !ap || ap.hash !== s.hash) return null;
    return s.allow;
  }
}
