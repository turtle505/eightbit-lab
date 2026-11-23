import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, type OfficeConfig, type RoleConfig } from '../config.ts';

/**
 * Pick the employee's working directory.
 * - useWorktree + researchRepo: a personal git worktree on branch office/<id>
 * - researchRepo: the repo itself
 * - otherwise: a shared folder under workspaceRoot
 */
export function ensureWorkspace(office: OfficeConfig, role: RoleConfig): string {
  if (role.cwd) {
    const dir = resolve(ROOT, role.cwd);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (!office.researchRepo) {
    const dir = resolve(office.workspaceRoot, 'shared');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (!role.useWorktree) return office.researchRepo;

  const dir = resolve(office.workspaceRoot, `wt-${role.id}`);
  if (existsSync(dir)) return dir;
  mkdirSync(office.workspaceRoot, { recursive: true });
  const branch = `office/${role.id}`;
  const git = (...args: string[]) => execFileSync('git', ['-C', office.researchRepo, ...args], { stdio: 'pipe' }).toString();
  const hasBranch = (() => {
    try {
      git('rev-parse', '--verify', '--quiet', branch);
      return true;
    } catch {
      return false;
    }
  })();
  if (hasBranch) git('worktree', 'add', dir, branch);
  else git('worktree', 'add', '-b', branch, dir);
  return dir;
}
