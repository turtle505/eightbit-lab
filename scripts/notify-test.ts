// npm run notify:test — send one test notification through every channel in `notify` (office(.local).yaml).
import { loadOffice } from '../server/src/config.ts';
import { Notifier } from '../server/src/notify.ts';

const n = new Notifier(loadOffice().notify);
if (!n.channels.length) {
  console.log('No notify channel set. Add one to config/office.local.yaml, e.g.\n  notify:\n    ntfy: https://ntfy.sh/<long-random-topic>');
  process.exit(1);
}
const ok = await n.send('result', '👾 8-bit Lab test', 'If you can read this, notifications work. / 이게 보이면 알림이 됩니다.', 'default', true);
console.log(ok ? `✓ Sent via ${n.channels.join(' + ')}.` : '✖ Nothing got through; see the warning above.');
process.exit(ok ? 0 : 1);
