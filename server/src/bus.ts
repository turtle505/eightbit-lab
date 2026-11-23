import { EventEmitter } from 'node:events';
import type { ServerMsg } from '../../shared/protocol.ts';

/** Broadcast channel: every ServerMsg emitted here is pushed to all connected browsers. */
class Bus extends EventEmitter {
  send(msg: ServerMsg) {
    this.emit('msg', msg);
  }
}

export const bus = new Bus();
