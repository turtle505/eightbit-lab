import { randomUUID } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Approval } from '../../../shared/protocol.ts';
import { bus } from '../bus.ts';

interface Pending {
  approval: Approval;
  resolve: (r: PermissionResult) => void;
}

/** Holds tool calls that need the manager's OK and resolves them when the UI answers. */
export class PermissionBroker {
  private pending = new Map<string, Pending>();

  list(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  request(employeeId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const approval: Approval = { id: randomUUID(), employeeId, toolName, input, createdAt: Date.now() };
    return new Promise((resolve) => {
      const done = (r: PermissionResult) => {
        if (!this.pending.delete(approval.id)) return;
        bus.send({ t: 'approvalResolved', id: approval.id });
        resolve(r);
      };
      this.pending.set(approval.id, { approval, resolve: done });
      signal.addEventListener('abort', () => done({ behavior: 'deny', message: 'aborted' }), { once: true });
      bus.send({ t: 'approval', data: approval });
    });
  }

  answer(id: string, allow: boolean, message?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.resolve(
      allow
        ? { behavior: 'allow', updatedInput: p.approval.input }
        : { behavior: 'deny', message: message || 'The manager denied this action. Find another way, or ask why.' },
    );
    return true;
  }

  forEmployee(employeeId: string): string[] {
    return this.list().filter((a) => a.employeeId === employeeId).map((a) => a.id);
  }

  cancelFor(employeeId: string) {
    for (const id of this.forEmployee(employeeId)) this.answer(id, false, 'stopped');
  }
}
